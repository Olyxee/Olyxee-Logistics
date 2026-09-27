import { Router } from "express";
import {
  db,
  ordersTable,
  customersTable,
  trackingEventsTable,
  emailNotificationsTable,
  smsNotificationsTable,
  notificationEventsTable,
  notificationDeliveriesTable,
  callRecordsTable,
  auditLogsTable,
  businessesTable,
  invoicesTable,
  jobCostsTable,
} from "@workspace/db";
import { eq, and, ilike, or, desc, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { companyAcronym, generateId, generateTrackingId, resolveTrackingPrefix } from "../lib/id";
import { sendStatusEmail, buildEmailBody, sendInvoiceEmail } from "../lib/email";
import { getMonthlyEmailUsage } from "../lib/email-usage";
import { effectiveEmailLimit } from "../lib/plan-enforcement";
import { sendOrderSms } from "../lib/order-notifications";
import { recordNotification, type DeliveryStatus } from "../lib/notifications";
import { getPlan } from "@workspace/plans";
import { z } from "zod";
import {
  FSM_ORDER_STATUSES,
  transitionOrder,
  findStuckOrders,
  ConcurrentTransitionError,
  type OrderFsmStatus,
} from "../lib/order-fsm";
import {
  isTransportMode,
  isStatusValidForMode,
  isLogisticsStatus,
  isLogisticsTerminal,
  logisticsFlow,
  logisticsStatusLabel,
  isForwardLogisticsProgression,
  SHIPMENT_EXCEPTION_TYPES,
  shipmentExceptionExplanation,
} from "@workspace/order-statuses";

// A business is "logistics" when its industry (aka business type in the UI)
// mentions logistics — the UI stores the label "Logistics Company".
export function isLogisticsBusiness(industry: string | null | undefined): boolean {
  return !!industry && industry.toLowerCase().includes("logistics");
}

const router = Router();
const SupplierTrackingBody = z.object({ supplierTrackingNumber: z.string().trim().min(2).max(200) });
const ShipmentBoxBody = z.object({
  weightKg: z.number().positive().max(100000),
  lengthCm: z.number().positive().max(100000).optional(),
  widthCm: z.number().positive().max(100000).optional(),
  heightCm: z.number().positive().max(100000).optional(),
}).refine(box => {
  const count = [box.lengthCm, box.widthCm, box.heightCm].filter(value => value !== undefined).length;
  return count === 0 || count === 3;
}, "Add all three dimensions, or leave all three blank.");
const UpdateOrderBody = z.object({ orderReference:z.string().max(200).nullable().optional(), description:z.string().max(5000).nullable().optional(), cargoType:z.string().max(500).nullable().optional(), serviceRequired:z.string().max(500).nullable().optional(), origin:z.string().max(500).nullable().optional(), destination:z.string().max(500).nullable().optional(), weight:z.string().max(200).nullable().optional(), dimensions:z.string().max(200).nullable().optional(), shipmentBoxes:z.array(ShipmentBoxBody).min(1).max(200).nullable().optional(), estimatedDeliveryDate:z.string().max(100).nullable().optional() });

// Create-Job body. Replaces the generated CreateOrderBody (which had drifted
// from openapi.yaml) so we can add jobNumber + billingType and enforce the
// PREPAID-only invoice-amount rule in one place. jobNumber is required and
// unique per business; billingType selects the workflow.
const CreateJobBody = z
  .object({
    customerId: z.string().min(1),
    jobNumber: z.string().trim().min(1).max(100),
    transportMode: z.enum(["AIR", "SEA"]),
    billingType: z.enum(["PREPAID", "POSTPAID"]),
    cargoType: z.string().min(1),
    serviceRequired: z.string().min(1),
    weight: z.string().min(1),
    shipmentBoxes: z.array(ShipmentBoxBody).min(1).max(200).optional(),
    orderReference: z.string().max(200).optional(),
    description: z.string().max(5000).optional(),
    estimatedDeliveryDate: z.string().max(100).optional(),
    origin: z.string().max(500).optional(),
    destination: z.string().max(500).optional(),
    dimensions: z.string().max(200).optional(),
    // Invoice pricing: required for PREPAID (enforced below), optional for
    // POSTPAID where the amount is set when invoicing after delivery.
    invoiceSubtotal: z.string().optional(),
    invoiceAdditionalCharges: z.string().optional(),
    jobCost: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.billingType === "PREPAID" && !data.invoiceSubtotal?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["invoiceSubtotal"],
        message: "Invoice subtotal is required for prepaid Jobs.",
      });
    }
  });

// Self-healing schema guard (mirrors ensureAuthColumns in routes/auth.ts). A
// production database deployed before the jobs/billing migration is missing the
// `job_number` / `billing_type` columns, which would make every order query
// fail. The DDL is additive and idempotent (IF NOT EXISTS), so it is safe to run
// lazily before the first order request and is a no-op once the columns exist.
// Memoized per warm process; the memo is cleared on failure so a later request
// can retry. The checked-in migration (0003) remains the source of truth.
let _jobsSchemaReady: Promise<void> | null = null;
async function ensureJobsSchema(): Promise<void> {
  if (_jobsSchemaReady) return _jobsSchemaReady;
  _jobsSchemaReady = (async () => {
    await db.execute(sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "job_number" text`);
    await db.execute(sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "billing_type" text NOT NULL DEFAULT 'PREPAID'`);
    await db.execute(sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "billing_status" text NOT NULL DEFAULT 'NOT_INVOICED'`);
    await db.execute(sql`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp`);
    await db.execute(sql`ALTER TABLE "tracking_events" ADD COLUMN IF NOT EXISTS "exception_type" text`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS "job_costs" (
      "id" text PRIMARY KEY NOT NULL,
      "business_id" text NOT NULL,
      "order_id" text NOT NULL,
      "category" text NOT NULL DEFAULT 'OTHER',
      "amount" numeric(14,2) NOT NULL,
      "currency" text NOT NULL DEFAULT 'ZAR',
      "note" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "job_costs_business_order_idx" ON "job_costs" ("business_id","order_id")`);
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "orders_business_job_number_unique" ON "orders" ("business_id", "job_number") WHERE "job_number" IS NOT NULL`,
    );
  })().catch((err) => {
    _jobsSchemaReady = null;
    throw err;
  });
  return _jobsSchemaReady;
}

// Run the self-heal once before any order route touches the new columns.
router.use((req, res, next) => {
  ensureJobsSchema().then(() => next()).catch((err) => {
    req.log?.error({ err }, "Failed to ensure jobs schema");
    res.status(503).json({ error: "Service temporarily unavailable" });
  });
});

function invoiceDueDate(paymentTerms: string | null | undefined, issueDate = new Date()): Date {
  const match = paymentTerms?.match(/\b(\d{1,3})\s*days?\b/i);
  const days = match ? Math.min(Number(match[1]), 365) : 0;
  const due = new Date(issueDate);
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

// Where customers go to see their order status. Businesses with their own
// website link to their own /track page; businesses without one fall back to
// the Olyxee-hosted tracking page so the email link always works even when
// the business has no site of its own.
const HOSTED_TRACKING_BASE = (
  process.env.PUBLIC_TRACKING_URL || "https://logistics.olyxee.com"
).replace(/\/$/, "");

function buildTrackingLink(_websiteUrl: string, trackingId: string): string {
  // Customer tracking always points at the platform's own public tracking page
  // for now: a tenant's own website may not be ready to host tracking yet, so
  // linking there risks a dead end. The page is branded per business, so the
  // customer never needs to know Olyxee powers it. (_websiteUrl kept for
  // signature compatibility with existing call sites.)
  return `${HOSTED_TRACKING_BASE}/track?code=${trackingId}`;
}

function buildBusinessTrackingLink(pageUrl: string | null | undefined, trackingId: string): string | undefined {
  const raw = pageUrl?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.searchParams.set("code", trackingId);
    return url.toString();
  } catch {
    return undefined;
  }
}

function serializeOrder(o: typeof ordersTable.$inferSelect) {
  return {
    ...o,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function serializeCustomer(c: typeof customersTable.$inferSelect) {
  return { ...c, createdAt: c.createdAt.toISOString() };
}

router.get("/orders", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const customerId = req.query.customerId as string | undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const whereConditions: any[] = [eq(ordersTable.businessId, businessId)];
    if (status) whereConditions.push(eq(ordersTable.currentStatus, status));
    if (customerId) whereConditions.push(eq(ordersTable.customerId, customerId));
    if (search) {
      whereConditions.push(
        or(
          ilike(ordersTable.jobNumber, `%${search}%`),
          ilike(ordersTable.trackingId, `%${search}%`),
          ilike(ordersTable.supplierTrackingNumber, `%${search}%`),
          ilike(ordersTable.orderReference, `%${search}%`),
          ilike(customersTable.fullName, `%${search}%`),
          ilike(customersTable.email, `%${search}%`),
        ),
      );
    }

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(ordersTable)
        .leftJoin(
          customersTable,
          and(
            eq(ordersTable.customerId, customersTable.id),
            eq(customersTable.businessId, businessId),
          ),
        )
        .where(and(...whereConditions))
        .orderBy(desc(ordersTable.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(ordersTable)
        .leftJoin(
          customersTable,
          and(
            eq(ordersTable.customerId, customersTable.id),
            eq(customersTable.businessId, businessId),
          ),
        )
        .where(and(...whereConditions)),
    ]);

    const data = rows.map(({ orders: o, customers: c }) => ({
      id: o.id,
      trackingId: o.trackingId,
      orderReference: o.orderReference,
      currentStatus: o.currentStatus,
      transportMode: o.transportMode,
      estimatedDeliveryDate: o.estimatedDeliveryDate,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      customer: c ? serializeCustomer(c) : null,
    }));

    res.json({ data, total: countResult[0]?.count ?? 0, page, limit });
  } catch (err) {
    req.log.error({ err }, "Failed to list orders");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/orders/next-job-number", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const [business, jobs] = await Promise.all([
      db.query.businessesTable.findFirst({ where: eq(businessesTable.id, businessId) }),
      db.select({ jobNumber: ordersTable.jobNumber }).from(ordersTable).where(eq(ordersTable.businessId, businessId)),
    ]);
    if (!business) { res.status(404).json({ error: "Business not found" }); return; }

    const highestSequence = jobs.reduce((highest, job) => {
      const match = job.jobNumber?.match(/^[A-Z0-9]+-(\d+)-(\d{4})$/i);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    const nextSequence = Math.max(jobs.length + 1, highestSequence + 1);
    const year = new Date().getFullYear();
    res.json({
      acronym: companyAcronym(business.name),
      sequence: nextSequence,
      jobNumber: `${companyAcronym(business.name)}-${String(nextSequence).padStart(4, "0")}-${year}`,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to generate next Job Number");
    res.status(500).json({ error: "Could not generate a Job Number" });
  }
});

router.post("/orders", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const userId = (req as any).userId;
    const parse = CreateJobBody.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "Invalid input", details: parse.error.issues });
      return;
    }

    const billingType = parse.data.billingType;
    const isPrepaid = billingType === "PREPAID";
    const jobNumber = parse.data.jobNumber.trim();

    // Verify customer belongs to business
    const customer = await db.query.customersTable.findFirst({
      where: and(
        eq(customersTable.id, parse.data.customerId),
        eq(customersTable.businessId, businessId),
      ),
    });
    if (!customer) {
      res.status(400).json({ error: "Customer not found" });
      return;
    }

    // Job Number is unique within this business (scoped, so it never reveals
    // another tenant's data). The DB partial unique index is the race-safe
    // backstop; this pre-check gives a clear message in the common case.
    const jobNumberClash = await db.query.ordersTable.findFirst({
      where: and(
        eq(ordersTable.businessId, businessId),
        eq(ordersTable.jobNumber, jobNumber),
      ),
    });
    if (jobNumberClash) {
      res.status(409).json({ error: `Job Number "${jobNumber}" is already in use. Enter a unique Job Number.` });
      return;
    }

    const business = await db.query.businessesTable.findFirst({
      where: eq(businessesTable.id, businessId),
    });

    // The console covers cross-border shipments only. Selecting AIR or SEA
    // is mandatory so the order enters the correct tracking workflow.
    const transportMode = parse.data.transportMode;
    if (!transportMode) {
      res.status(400).json({
        error: "transportMode is required (AIR or SEA)",
      });
      return;
    }
    if (!isTransportMode(transportMode)) {
      res.status(400).json({ error: "Invalid transportMode" });
      return;
    }

    // Both billing types start at ORDER_CONFIRMED ("Job Confirmed" to
    // customers). PREPAID is gated on payment before it can advance; POSTPAID
    // can progress freely and is invoiced after delivery.
    const initialStatus = "ORDER_CONFIRMED";
    const initialMessage = isPrepaid
      ? "Job created - awaiting payment confirmation"
      : "Job created";
    // Invoice amounts only matter for PREPAID (required, validated above).
    // POSTPAID enters its amount when invoicing after delivery.
    const subtotal = Number(parse.data.invoiceSubtotal ?? "0");
    const additionalCharges = Number(parse.data.invoiceAdditionalCharges ?? "0");
    const rawJobCost = parse.data.jobCost?.trim();
    const jobCost = rawJobCost ? Number(rawJobCost) : 0;
    if (isPrepaid && (!Number.isFinite(subtotal) || !Number.isFinite(additionalCharges) || subtotal < 0 || additionalCharges < 0)) {
      res.status(400).json({ error: "Invoice amounts must be non-negative numbers" });
      return;
    }
    if (rawJobCost && (!Number.isFinite(jobCost) || jobCost < 0)) {
      res.status(400).json({ error: "Job cost must be a non-negative number" });
      return;
    }
    const hasJobCost = !!rawJobCost && jobCost > 0;

    // Generate a unique tracking ID. We let the DB enforce uniqueness via
    // the trackingId unique constraint and retry on a 23505 (unique_violation)
    // - this is the only race-free pattern. Concurrent inserts under a
    // pre-check-only loop can both pass the SELECT then collide on INSERT,
    // surfacing as a 500. ~26 bits of entropy per ID per business make
    // collisions vanishingly rare, but a bounded retry keeps things safe.
    const prefix = resolveTrackingPrefix(
      business?.trackingIdPrefix,
      business?.name,
      business?.slug,
    );
    const MAX_TRACKING_ATTEMPTS = 8;
    let inserted: typeof ordersTable.$inferSelect | undefined;
    let lastErr: unknown;
    let jobNumberConflict = false;
    // Walk the (possibly Drizzle-wrapped) error chain for the pg constraint name.
    const constraintOf = (err: unknown): string => {
      let cur = err as { constraint?: string; cause?: unknown } | undefined;
      for (let i = 0; i < 6 && cur; i++) {
        if (cur.constraint) return cur.constraint;
        cur = cur.cause as typeof cur;
      }
      return "";
    };
    for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS; attempt++) {
      const candidate = generateTrackingId(prefix);
      try {
        const rows = await db
          .insert(ordersTable)
          .values({
            id: generateId(),
            businessId,
            customerId: parse.data.customerId,
            trackingId: candidate,
            jobNumber,
            billingType,
            orderReference: parse.data.orderReference ?? null,
            description: parse.data.description ?? null,
            currentStatus: initialStatus,
            transportMode,
            cargoType: parse.data.cargoType ?? null,
            serviceRequired: parse.data.serviceRequired ?? null,
            origin: parse.data.origin ?? null,
            destination: parse.data.destination ?? null,
            weight: parse.data.weight ?? null,
            dimensions: parse.data.dimensions ?? null,
            shipmentBoxes: parse.data.shipmentBoxes ?? null,
            estimatedDeliveryDate: parse.data.estimatedDeliveryDate ?? null,
          })
          .returning();
        inserted = rows[0];
        break;
      } catch (err) {
        lastErr = err;
        // Postgres unique_violation. Any other error is real and should bubble.
        const code = (err as { code?: string } | undefined)?.code;
        if (code !== "23505") throw err;
        // A job_number collision (lost the race against the pre-check) must NOT
        // retry with a fresh tracking ID — the job_number is still a duplicate.
        // Surface a clean 409 instead of exhausting attempts into a 500.
        if (constraintOf(err) === "orders_business_job_number_unique") {
          jobNumberConflict = true;
          break;
        }
        req.log.warn(
          { attempt, candidate },
          "Tracking ID collision on insert, retrying",
        );
      }
    }
    if (jobNumberConflict) {
      res.status(409).json({ error: `Job Number "${jobNumber}" is already in use. Enter a unique Job Number.` });
      return;
    }
    if (!inserted) {
      req.log.error({ err: lastErr }, "Exhausted tracking ID attempts");
      res.status(500).json({ error: "Could not allocate tracking ID" });
      return;
    }
    const o = inserted;
    const trackingId = o.trackingId;

    // POSTPAID: no invoice and no invoice email at creation. Record the "Job
    // created" tracking event so the shipment timeline starts, then return. The
    // invoice is created later, after delivery, via POST /invoices (which links
    // it back through orders.invoice_id).
    if (!isPrepaid) {
      await db.transaction(async (tx) => {
        if (hasJobCost) await tx.insert(jobCostsTable).values({id:generateId(),businessId,orderId:o.id,category:"OTHER",amount:jobCost.toFixed(2),currency:"ZAR",note:"Recorded when Job was created"});
        await tx.insert(trackingEventsTable).values({id:generateId(),orderId:o.id,status:initialStatus,message:initialMessage,createdBy:userId});
        await tx.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"CREATE_JOB",entityType:"order",entityId:o.id,metadata:{trackingId:o.trackingId,jobNumber,billingType}});
      });
      res.status(201).json({...serializeOrder(o),invoiceId:null,invoiceEmailStatus:"skipped"});
      return;
    }

    // PREPAID: create + link the invoice, then attempt to auto-send it.
    const invoiceId = generateId();
    const invoiceNo = `INV-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${generateId().slice(0,6).toUpperCase()}`;
    const dueDate = invoiceDueDate(business?.invoicePaymentTerms);
    const total = subtotal + additionalCharges;

    await db.transaction(async (tx) => {
      await tx.insert(invoicesTable).values({id:invoiceId,businessId,invoiceNumber:invoiceNo,customerId:customer.id,orderId:o.id,subtotal:String(subtotal),additionalCharges:String(additionalCharges),total:String(total),currency:"ZAR",dueDate,status:"draft",notes:"Payment due within agreed terms."});
      if (hasJobCost) await tx.insert(jobCostsTable).values({id:generateId(),businessId,orderId:o.id,category:"OTHER",amount:jobCost.toFixed(2),currency:"ZAR",note:"Recorded when Job was created"});
      // Invoice now exists -> billing_status INVOICED (advances to
      // AWAITING_PAYMENT below once the email actually sends).
      await tx.update(ordersTable).set({invoiceId,billingStatus:"INVOICED",updatedAt:new Date()}).where(and(eq(ordersTable.id,o.id),eq(ordersTable.businessId,businessId)));
      await tx.insert(trackingEventsTable).values({id:generateId(),orderId:o.id,status:initialStatus,message:initialMessage,createdBy:userId});
      await tx.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"CREATE_ORDER_AND_INVOICE",entityType:"order",entityId:o.id,metadata:{trackingId:o.trackingId,invoiceId,invoiceNumber:invoiceNo}});
    });

    const delivery = business ? await sendInvoiceEmail({businessId,senderBusinessName:business.name,customerEmail:customer.email,customerName:customer.fullName,customerAddress:customer.address,customerPhone:customer.phone,invoiceNumber:invoiceNo,createdAt:new Date(),dueDate,description:o.cargoType||o.description||"Cross-border logistics service",serviceDetails:o.serviceRequired||"",quantity:1,subtotal,additionalCharges,total,currency:"ZAR",businessName:business.invoiceLegalName||business.name,supportEmail:business.invoiceEmail||business.supportEmail,businessPhone:business.invoicePhone||business.phone,businessAddress:business.invoiceAddress||business.location,logoUrl:business.businessLogoUrl||business.invoiceLogoUrl,companyRegistration:business.invoiceRegistrationNumber||undefined,taxNumber:business.invoiceTaxNumber,paymentDetails:business.invoicePaymentDetails,paymentTerms:business.invoicePaymentTerms,footerNote:business.invoiceFooterNote,primaryColor:business.primaryBrandColour,orderReference:o.orderReference,jobNumber:o.jobNumber,trackingId:o.trackingId,externalTrackingNumber:o.supplierTrackingNumber,origin:o.origin,destination:o.destination,transportMode:o.transportMode,weight:o.weight}) : {success:false,error:"Business not found"};
    if(delivery.success){
      await db.update(invoicesTable).set({status:"sent",sentAt:new Date(),updatedAt:new Date()}).where(and(eq(invoicesTable.id,invoiceId),eq(invoicesTable.businessId,businessId)));
      // Invoice sent -> billing_status AWAITING_PAYMENT.
      await db.update(ordersTable).set({billingStatus:"AWAITING_PAYMENT",updatedAt:new Date()}).where(and(eq(ordersTable.id,o.id),eq(ordersTable.businessId,businessId)));
      await db.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"AUTO_SEND_INVOICE",entityType:"invoice",entityId:invoiceId,metadata:{messageId:delivery.messageId,customerEmail:customer.email}});
    } else {
      req.log?.error({invoiceId,error:delivery.error},"Automatic invoice email failed");
    }
    res.status(201).json({...serializeOrder({...o,invoiceId}),invoiceId,invoiceEmailStatus:delivery.success?"sent":"failed"});
  } catch (err) {
    req.log.error({ err }, "Failed to create order");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/orders/:orderId/supplier-tracking", requireAuth, async (req, res) => {
  try {
    const parsed = SupplierTrackingBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid input", details: parsed.error.issues }); return; }
    const businessId = (req as any).businessId, userId = (req as any).userId;
    const orderId = String(req.params.orderId);
    const order = await db.query.ordersTable.findFirst({ where: and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId)) });
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    if (!order.transportMode) { res.status(409).json({ error: "Supplier tracking is only available for air or sea Jobs" }); return; }
    if (order.supplierTrackingNumber) { res.status(409).json({ error: "Supplier tracking number has already been recorded" }); return; }
    // Supplier tracking is optional metadata added whenever it arrives - it must
    // never block a Job. Only two guards: don't add after delivery, and (for
    // PREPAID, pay-first) require the invoice to be paid first. POSTPAID has no
    // payment gate here.
    if (isLogisticsTerminal(order.currentStatus)) { res.status(409).json({ error: "This Job is already delivered; the supplier tracking number can no longer be added" }); return; }
    if (order.billingType === "PREPAID" && order.invoiceId) {
      const invoice = await db.query.invoicesTable.findFirst({ where: and(eq(invoicesTable.id, order.invoiceId), eq(invoicesTable.businessId, businessId)) });
      if (!invoice || invoice.status !== "paid") { res.status(409).json({ error: "Payment must be confirmed before adding the supplier tracking number" }); return; }
    }
    const supplierTrackingNumber = parsed.data.supplierTrackingNumber.toUpperCase();
    const duplicate = await db.query.ordersTable.findFirst({ where: and(eq(ordersTable.businessId, businessId), eq(ordersTable.supplierTrackingNumber, supplierTrackingNumber)) });
    if (duplicate && duplicate.id !== orderId) { res.status(409).json({ error: `Supplier tracking number is already linked to Job ${duplicate.jobNumber ?? duplicate.orderReference ?? duplicate.id}` }); return; }
    // If the Job is waiting on a tracking number, recording it advances the
    // shipment to RECEIVED_FROM_SUPPLIER (with a customer-visible event).
    // Otherwise we just record the number without touching the shipment stage.
    const advancing = order.currentStatus === "PENDING_TRACKING_NUMBER";
    const now = new Date();
    const updated = await db.transaction(async(tx)=>{
      const [nextOrder] = await tx.update(ordersTable).set({ supplierTrackingNumber, supplierTrackingNumberAddedAt: now, supplierTrackingNumberAddedBy: userId, ...(advancing ? { currentStatus: "RECEIVED_FROM_SUPPLIER" } : {}), updatedAt: now }).where(and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId))).returning();
      if (advancing) {
        await tx.insert(trackingEventsTable).values({id:generateId(),orderId,status:"RECEIVED_FROM_SUPPLIER",message:"Cargo received at the China warehouse; shipment tracking is now active",location:"China warehouse",createdBy:userId});
      }
      await tx.insert(auditLogsTable).values({ id: generateId(), businessId, userId, action: "SET_SUPPLIER_TRACKING_NUMBER", entityType: "order", entityId: orderId, metadata: { previousValue: order.supplierTrackingNumber, newValue: supplierTrackingNumber, addedAt: now.toISOString(), advanced: advancing } });
      return nextOrder;
    });
    res.json(serializeOrder(updated));
  } catch (err) { req.log.error({ err }, "Failed to set supplier tracking number"); res.status(500).json({ error: "Internal server error" }); }
});

// GET /orders/stuck - must be declared BEFORE /orders/:orderId so Express
// doesn't treat "stuck" as an order ID param. Returns orders whose dwell
// time in a watched lifecycle state exceeds the configured threshold.
router.get("/orders/stuck", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const stuck = await findStuckOrders(businessId);
    res.json({ data: stuck, total: stuck.length });
  } catch (err) {
    req.log.error({ err }, "Failed to list stuck orders");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/orders/:orderId", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const orderId = req.params.orderId as string;

    const order = await db.query.ordersTable.findFirst({
      where: and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId)),
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const [customer, business, invoice, trackingEvents, emailNotifications] = await Promise.all([
      db.query.customersTable.findFirst({
        where: and(
          eq(customersTable.id, order.customerId),
          eq(customersTable.businessId, businessId),
        ),
      }),
      db.query.businessesTable.findFirst({ where: eq(businessesTable.id, businessId) }),
      order.invoiceId ? db.query.invoicesTable.findFirst({ where: and(eq(invoicesTable.id, order.invoiceId), eq(invoicesTable.businessId, businessId)) }) : Promise.resolve(null),
      db
        .select()
        .from(trackingEventsTable)
        .where(eq(trackingEventsTable.orderId, orderId))
        .orderBy(desc(trackingEventsTable.createdAt)),
      db
        .select()
        .from(emailNotificationsTable)
        .where(eq(emailNotificationsTable.orderId, orderId))
        .orderBy(desc(emailNotificationsTable.createdAt)),
    ]);

    const trackingLink = business
      ? buildTrackingLink(business.websiteUrl, order.trackingId)
      : "";

    res.json({
      ...serializeOrder(order),
      trackingLink,
      invoiceStatus: invoice?.status ?? null,
      customer: customer ? serializeCustomer(customer) : null,
      trackingEvents: trackingEvents.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
      })),
      emailNotifications: emailNotifications.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get order");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/orders/:orderId", requireAuth, async (req, res) => {
  try {
    const parsed=UpdateOrderBody.safeParse(req.body); if(!parsed.success){res.status(400).json({error:"Invalid input",details:parsed.error.issues});return;}
    const businessId=(req as any).businessId,userId=(req as any).userId,orderId=String(req.params.orderId);
    const existing=await db.query.ordersTable.findFirst({where:and(eq(ordersTable.id,orderId),eq(ordersTable.businessId,businessId))});
    if(!existing){res.status(404).json({error:"Order not found"});return;}
    const [updated]=await db.update(ordersTable).set({...parsed.data,updatedAt:new Date()}).where(and(eq(ordersTable.id,orderId),eq(ordersTable.businessId,businessId))).returning();
    await db.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"UPDATE_ORDER",entityType:"order",entityId:orderId,metadata:{changes:parsed.data}});
    res.json(serializeOrder(updated));
  } catch(err){req.log.error({err},"Failed to update order");res.status(500).json({error:"Internal server error"});}
});

router.delete("/orders/:orderId", requireAuth, async (req, res) => {
  try {
    const businessId=(req as any).businessId,userId=(req as any).userId,orderId=String(req.params.orderId);
    const order=await db.query.ordersTable.findFirst({where:and(eq(ordersTable.id,orderId),eq(ordersTable.businessId,businessId))});
    if(!order){res.status(404).json({error:"Order not found"});return;}
    await db.transaction(async tx=>{
      const notificationEvents = await tx
        .select({ id: notificationEventsTable.id })
        .from(notificationEventsTable)
        .where(eq(notificationEventsTable.orderId, orderId));
      const notificationEventIds = notificationEvents.map((event) => event.id);
      if (notificationEventIds.length > 0) {
        await tx.delete(notificationDeliveriesTable).where(inArray(notificationDeliveriesTable.eventId, notificationEventIds));
      }
      await tx.delete(notificationEventsTable).where(eq(notificationEventsTable.orderId,orderId));
      await tx.delete(callRecordsTable).where(eq(callRecordsTable.orderId,orderId));
      await tx.delete(emailNotificationsTable).where(eq(emailNotificationsTable.orderId,orderId));
      await tx.delete(smsNotificationsTable).where(eq(smsNotificationsTable.orderId,orderId));
      await tx.delete(trackingEventsTable).where(eq(trackingEventsTable.orderId,orderId));
      // orders.invoice_id <-> invoices.order_id is a circular FK (neither
      // DEFERRABLE), so the invoice can't be deleted while the order still
      // points at it. Break the cycle by nulling invoice_id first, then delete
      // the invoice, then the order.
      await tx.update(ordersTable).set({invoiceId:null}).where(and(eq(ordersTable.id,orderId),eq(ordersTable.businessId,businessId)));
      await tx.delete(invoicesTable).where(and(eq(invoicesTable.orderId,orderId),eq(invoicesTable.businessId,businessId)));
      await tx.delete(ordersTable).where(and(eq(ordersTable.id,orderId),eq(ordersTable.businessId,businessId)));
      await tx.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"DELETE_ORDER",entityType:"order",entityId:orderId,metadata:{trackingId:order.trackingId,orderReference:order.orderReference,invoiceId:order.invoiceId}});
    });
    res.status(204).send();
  } catch(err){req.log.error({err},"Failed to delete order");res.status(500).json({error:"Internal server error"});}
});

// Local status-update body. Replaces the generated UpdateOrderStatusBody whose
// status enum only allowed the retired status codes. The status VALUE is
// validated per-mode by isStatusValidForMode below, so here we just require a
// non-empty string.
const UpdateJobStatusBody = z.object({
  status: z.string().trim().min(1).max(100),
  message: z.string().max(2000).optional(),
  location: z.string().max(500).optional(),
  exceptionType: z.enum(SHIPMENT_EXCEPTION_TYPES).optional(),
  notifyCustomer: z.boolean().default(true),
  skipReason: z.string().trim().max(500).optional(),
});

router.post("/orders/:orderId/status", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const userId = (req as any).userId;
    const orderId = req.params.orderId as string;
    const parse = UpdateJobStatusBody.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "Invalid input", details: parse.error.issues });
      return;
    }

    const { status, location, exceptionType, notifyCustomer, skipReason } = parse.data;
    const message = exceptionType
      ? parse.data.message?.trim() || shipmentExceptionExplanation(exceptionType)
      : parse.data.message?.trim() || undefined;

    const order = await db.query.ordersTable.findFirst({
      where: and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId)),
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    // PREPAID Jobs must have a paid invoice before the shipment can progress.
    // POSTPAID Jobs progress freely (they are invoiced after delivery).
    // Supplier tracking number is OPTIONAL and never gates progression - a Job
    // is never blocked just because no supplier number exists. Pre-invoice
    // legacy PREPAID orders stay grandfathered (no invoice_id -> no gate).
    if (order.billingType === "PREPAID" && order.invoiceId) {
      const invoice = await db.query.invoicesTable.findFirst({where:and(eq(invoicesTable.id,order.invoiceId),eq(invoicesTable.businessId,businessId))});
      if (!invoice || invoice.status !== "paid") {
        res.status(409).json({ error: "Payment must be confirmed before tracking updates can begin", invoiceStatus: invoice?.status ?? "missing" });
        return;
      }
    }

    // Transport-aware validation. Orders with a transport mode may only move
    // through their mode's flow (e.g. no vessel stages on AIR shipments) and
    // DELIVERED is terminal. Orders WITHOUT a mode (non-logistics + legacy
    // logistics orders) keep the generic flow and must not receive logistics
    // status codes.
    if (order.transportMode) {
      if (isLogisticsTerminal(order.currentStatus)) {
        res.status(409).json({
          error: "Order is already delivered; no further status changes allowed",
        });
        return;
      }
      if (!isStatusValidForMode(order.transportMode, status)) {
        res.status(422).json({
          error: `Status "${status}" is not valid for ${order.transportMode} shipments`,
          allowedStatuses: logisticsFlow(order.transportMode) ?? [],
        });
        return;
      }
      // Freight teams may skip forward when intermediate carrier updates never
      // arrive, but a normal status update must never move a shipment backwards.
      // Legacy codes are normalized before comparison so older Jobs continue
      // safely from their equivalent position in the current AIR/SEA flow.
      if (!isForwardLogisticsProgression(order.transportMode, order.currentStatus, status)) {
        res.status(409).json({ error: "Shipment status cannot move backwards", currentStatus: order.currentStatus });
        return;
      }
    } else if (isLogisticsStatus(status)) {
      res.status(422).json({
        error:
          "This order has no transport mode, so transport-specific statuses cannot be applied",
      });
      return;
    }

    const [customer, business] = await Promise.all([
      db.query.customersTable.findFirst({
        where: and(
          eq(customersTable.id, order.customerId),
          eq(customersTable.businessId, businessId),
        ),
      }),
      db.query.businessesTable.findFirst({ where: eq(businessesTable.id, businessId) }),
    ]);

    // Wrap the DB writes (tracking event + order update) in a transaction so a
    // partial failure can't leave the order with a bumped tracking event but
    // an out-of-date currentStatus. Email send + email_notifications write are
    // intentionally OUTSIDE the transaction so a slow SMTP call never holds a
    // DB transaction open.
    const { trackingEvent: tev, updatedOrder } = await db.transaction(async (tx) => {
      const trackingEvent = await tx
        .insert(trackingEventsTable)
        .values({
          id: generateId(),
          orderId,
          status,
          message: message ?? null,
          exceptionType: exceptionType ?? null,
          location: location ?? null,
          createdBy: userId,
        })
        .returning();

      // Stamp the actual delivery time the first time a Job reaches its terminal
      // state (new AIR/SEA DELIVERED_COLLECTED or legacy DELIVERED). Never clears
      // it and never keys off non-terminal legacy strings.
      const nowTs = new Date();
      const markDelivered = isLogisticsTerminal(status) && !order.deliveredAt;
      const updatedOrder = await tx
        .update(ordersTable)
        .set({
          currentStatus: status,
          updatedAt: nowTs,
          ...(markDelivered ? { deliveredAt: nowTs } : {}),
        })
        .where(
          and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId)),
        )
        .returning();

      // Belt-and-braces: if the update affected 0 rows (the order was deleted
      // or its business_id changed between the read above and this write),
      // throw to roll back the tracking event so we never end up with an
      // orphan event for a status that didn't actually take effect.
      if (!updatedOrder[0]) {
        throw new Error("Order disappeared mid-update");
      }

      return { trackingEvent, updatedOrder };
    });

    const trackingEvent = tev;

    // 3. Build tracking link
    const trackingLink = business
      ? buildTrackingLink(business.websiteUrl, order.trackingId)
      : "";

    // 4. Send email
    let emailStatus: "sent" | "failed" | "skipped" | "limit_reached" = "skipped";
    let emailNotificationId: string | undefined;
    let emailUsage: number | undefined;
    let emailLimit: number | undefined;

    if (notifyCustomer && customer && business) {
      // Build a customer-facing progress timeline from this Job's tracking
      // events. Only reached, customer-visible logistics statuses are included,
      // and only their friendly LABEL is used — the event notes/messages (which
      // can contain internal detail) are never exposed. Deduped, oldest-first.
      let timeline: { label: string; done: boolean }[] = [];
      if (order.transportMode) {
        const events = await db
          .select({ status: trackingEventsTable.status })
          .from(trackingEventsTable)
          .where(eq(trackingEventsTable.orderId, orderId))
          .orderBy(trackingEventsTable.createdAt);
        const seen = new Set<string>();
        timeline = events
          .filter((e) => isLogisticsStatus(e.status) && !seen.has(e.status) && seen.add(e.status))
          .map((e) => ({ label: logisticsStatusLabel(e.status), done: true }));
      }

      const emailParams = {
        businessId,
        customerEmail: customer.email,
        customerName: customer.fullName,
        trackingId: order.trackingId,
        jobNumber: order.jobNumber,
        // For transport-aware orders the internal code (e.g. VESSEL_DEPARTED)
        // must never leak into customer emails — use the friendly label.
        status: order.transportMode ? logisticsStatusLabel(status) : status,
        statusMessage: message ?? null,
        trackingLink,
        businessTrackingLink: buildBusinessTrackingLink(business.customerTrackingPageUrl, order.trackingId),
        timeline,
        businessName: business.name,
        supportEmail: business.supportEmail,
        businessPhone: business.invoicePhone || business.phone,
        businessAddress: business.invoiceAddress || business.location,
        emailGreeting: business.emailGreeting,
        emailSignature: business.emailSignature,
        emailFooterNote: business.emailFooterNote,
      };

      const { subject, body } = buildEmailBody(emailParams);

      // Enforce the per-business monthly email allowance. Once reached we skip
      // the send entirely (so it doesn't consume the next month's quota) and
      // record a "limit_reached" row so the order history shows why no email
      // went out. The status update itself still succeeds.
      emailLimit = effectiveEmailLimit(business);
      emailUsage = await getMonthlyEmailUsage(businessId);

      if (emailUsage >= emailLimit) {
        emailStatus = "limit_reached";
        const notif = await db
          .insert(emailNotificationsTable)
          .values({
            id: generateId(),
            orderId,
            customerEmail: customer.email,
            subject,
            body,
            status: "limit_reached",
            providerMessageId: null,
          })
          .returning();
        emailNotificationId = notif[0]?.id;
      } else {
        const emailResult = await sendStatusEmail(emailParams);
        emailStatus = emailResult.success ? "sent" : "failed";
        if (emailStatus === "sent") emailUsage += 1;

        // 5. Save email notification
        const notif = await db
          .insert(emailNotificationsTable)
          .values({
            id: generateId(),
            orderId,
            customerEmail: customer.email,
            subject,
            body,
            status: emailStatus,
            providerMessageId: emailResult.messageId ?? null,
          })
          .returning();
        emailNotificationId = notif[0]?.id;
      }
    }

    // 5b. Send SMS if the customer has a phone number and SMS is configured.
    const sms = notifyCustomer && business ? await sendOrderSms({
      orderId,
      customerPhone: customer?.phone ?? undefined,
      businessName: business.name,
      trackingId: order.trackingId,
      // SMS is customer-facing too: send the friendly label, not the code.
      status: order.transportMode ? logisticsStatusLabel(status) : status,
      statusMessage: message ?? null,
      trackingLink,
      businessPlan: business.plan,
      businessId,
    }) : { smsStatus: "skipped" as const, smsNotificationId: undefined, smsUsage: undefined, smsLimit: undefined };
    const smsStatus = sms.smsStatus;
    const smsNotificationId = sms.smsNotificationId;
    const smsUsage = sms.smsUsage;
    const smsLimit = sms.smsLimit;

    // 6. Audit log
    await db.insert(auditLogsTable).values({
      id: generateId(),
      businessId,
      userId,
      action: "UPDATE_ORDER_STATUS",
      entityType: "order",
      entityId: orderId,
      metadata: { previousStatus: order.currentStatus, newStatus: status, exceptionType: exceptionType ?? null, skipReason: skipReason ?? null, notifyCustomer, emailStatus, smsStatus },
    });

    // 6b. Shared notification history (best-effort, additive). Mirrors the email
    // outcome above into the new notification_events / notification_deliveries
    // tables. Never throws into this path; the legacy email_notifications write
    // above remains the source of truth for existing UI.
    if (customer && (emailStatus !== "skipped" || smsStatus !== "skipped")) {
      const outcomes: Array<{
        channel: "email" | "sms";
        recipient: string;
        status: DeliveryStatus;
        failureReason: string | null;
      }> = [];

      if (emailStatus !== "skipped") {
        outcomes.push({
          channel: "email",
          recipient: customer.email,
          status: emailStatus === "sent" ? "sent" : "failed",
          failureReason:
            emailStatus === "limit_reached"
              ? "Monthly status-update limit reached"
              : emailStatus === "failed"
                ? "Status update couldn't be sent"
                : null,
        });
      }

      if (smsStatus !== "skipped") {
        outcomes.push({
          channel: "sms",
          recipient: customer.phone!,
          status: smsStatus === "sent" ? "sent" : "failed",
          failureReason:
            smsStatus === "limit_reached"
              ? "Monthly SMS limit reached"
              : smsStatus === "failed"
                ? "SMS provider send failed"
                : null,
        });
      }

      await recordNotification({
        orderId,
        businessId,
        status,
        message: message ?? null,
        outcomes,
      });
    }

    res.json({
      order: serializeOrder(updatedOrder[0]),
      trackingEvent: {
        ...trackingEvent[0],
        createdAt: trackingEvent[0].createdAt.toISOString(),
      },
      emailStatus,
      emailNotificationId,
      emailUsage,
      emailLimit,
      smsStatus,
      smsNotificationId,
      smsUsage,
      smsLimit,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update order status");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /orders/:orderId/transition - FSM-gated status change.
//
// Distinct from the legacy /status endpoint above: that one accepts any
// free-text status (used for "In transit", "Out for delivery", etc., which
// are tracking waypoints rather than lifecycle states). This endpoint
// enforces the typed Created→…→Delivered lifecycle and writes both a
// tracking-event row and a typed audit-log row inside one transaction.
const TransitionBody = z.object({
  toStatus: z.enum(FSM_ORDER_STATUSES),
  reason: z.string().trim().max(500).optional(),
});

router.post("/orders/:orderId/transition", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const userId = (req as any).userId;
    const orderId = req.params.orderId as string;

    // Wire format follows the spec: snake_case keys (`current_status`,
    // `event_id`). The FSM module stays camelCase internally - we serialize
    // at the route boundary so the public contract is exactly what was
    // requested without polluting the TS types.
    const parse = TransitionBody.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        current_status: null,
        message: "Invalid input",
        event_id: null,
        details: parse.error.issues,
      });
      return;
    }

    const result = await transitionOrder({
      orderId,
      businessId,
      toStatus: parse.data.toStatus as OrderFsmStatus,
      updatedBy: userId,
      reason: parse.data.reason ?? null,
    });

    if (!result.success) {
      // Map FSM failure codes onto HTTP statuses. 422 for "request understood
      // but the state machine refused it" reads more accurately than 400,
      // which we reserve for malformed input.
      const statusCode =
        result.code === "not_found"
          ? 404
          : result.code === "unknown_status"
            ? 400
            : 422;
      res.status(statusCode).json({
        success: false,
        current_status: result.currentStatus,
        message: result.message,
        event_id: null,
        code: result.code,
      });
      return;
    }

    res.json({
      success: true,
      current_status: result.currentStatus,
      message: result.message,
      event_id: result.eventId,
    });
  } catch (err) {
    if (err instanceof ConcurrentTransitionError) {
      // Another writer beat us between read and update - caller should
      // re-fetch and retry with the latest state.
      res.status(409).json({
        success: false,
        current_status: null,
        message: "Order was modified by another request. Please retry.",
        event_id: null,
        code: "conflict",
      });
      return;
    }
    req.log.error({ err }, "Failed to transition order");
    res.status(500).json({
      success: false,
      current_status: null,
      message: "Internal server error",
      event_id: null,
    });
  }
});

router.post("/orders/:orderId/resend-email", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const userId = (req as any).userId;
    const orderId = req.params.orderId as string;

    const order = await db.query.ordersTable.findFirst({
      where: and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId)),
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const [customer, business] = await Promise.all([
      db.query.customersTable.findFirst({
        where: and(
          eq(customersTable.id, order.customerId),
          eq(customersTable.businessId, businessId),
        ),
      }),
      db.query.businessesTable.findFirst({ where: eq(businessesTable.id, businessId) }),
    ]);

    if (!customer || !business) {
      res.status(400).json({ error: "Cannot resend email - missing customer or business data" });
      return;
    }

    const trackingLink = buildTrackingLink(business.websiteUrl, order.trackingId);
    const emailParams = {
      businessId,
      customerEmail: customer.email,
      customerName: customer.fullName,
      trackingId: order.trackingId,
      // Never leak internal logistics codes into a resent customer email.
      status: order.transportMode
        ? logisticsStatusLabel(order.currentStatus)
        : order.currentStatus,
      statusMessage: null,
      trackingLink,
      businessTrackingLink: buildBusinessTrackingLink(business.customerTrackingPageUrl, order.trackingId),
      businessName: business.name,
      supportEmail: business.supportEmail,
      businessPhone: business.invoicePhone || business.phone,
      businessAddress: business.invoiceAddress || business.location,
      emailGreeting: business.emailGreeting,
      emailSignature: business.emailSignature,
      emailFooterNote: business.emailFooterNote,
    };

    const { subject, body } = buildEmailBody(emailParams);

    // Same monthly allowance check as the status endpoint - a manual resend
    // counts against the quota too.
    const emailLimit = effectiveEmailLimit(business);
    const emailUsage = await getMonthlyEmailUsage(businessId);

    if (emailUsage >= emailLimit) {
      const notif = await db
        .insert(emailNotificationsTable)
        .values({
          id: generateId(),
          orderId,
          customerEmail: customer.email,
          subject,
          body,
          status: "limit_reached",
          providerMessageId: null,
        })
        .returning();

      await db.insert(auditLogsTable).values({
        id: generateId(),
        businessId,
        userId,
        action: "RESEND_EMAIL",
        entityType: "order",
        entityId: orderId,
        metadata: { emailStatus: "limit_reached" },
      });

      res.json({
        success: false,
        emailNotificationId: notif[0]?.id,
        message: `Monthly status-update limit reached (${emailUsage}/${emailLimit}). Upgrade to send more.`,
        emailStatus: "limit_reached",
        emailUsage,
        emailLimit,
      });
      return;
    }

    const emailResult = await sendStatusEmail(emailParams);
    const emailStatus = emailResult.success ? "sent" : "failed";

    const notif = await db
      .insert(emailNotificationsTable)
      .values({
        id: generateId(),
        orderId,
        customerEmail: customer.email,
        subject,
        body,
        status: emailStatus,
        providerMessageId: emailResult.messageId ?? null,
      })
      .returning();

    // Also resend SMS if the customer has a phone and SMS is configured.
    const sms = await sendOrderSms({
      orderId,
      customerPhone: customer.phone ?? undefined,
      businessName: business.name,
      trackingId: order.trackingId,
      status: order.transportMode
        ? logisticsStatusLabel(order.currentStatus)
        : order.currentStatus,
      statusMessage: null,
      trackingLink,
      businessPlan: business.plan,
      businessId,
    });
    const smsStatus = sms.smsStatus;
    const smsNotificationId = sms.smsNotificationId;
    const smsUsage = sms.smsUsage;
    const smsLimit = sms.smsLimit;

    await db.insert(auditLogsTable).values({
      id: generateId(),
      businessId,
      userId,
      action: "RESEND_EMAIL",
      entityType: "order",
      entityId: orderId,
      metadata: { emailStatus, smsStatus },
    });

    res.json({
      success: emailResult.success,
      emailNotificationId: notif[0]?.id,
      message: emailResult.success ? "Email resent successfully" : emailResult.error,
      emailStatus,
      emailUsage: emailStatus === "sent" ? emailUsage + 1 : emailUsage,
      emailLimit,
      smsStatus,
      smsNotificationId,
      smsUsage,
      smsLimit,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to resend email");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/orders/:orderId/tracking-events", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const orderId = req.params.orderId as string;

    const order = await db.query.ordersTable.findFirst({
      where: and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId)),
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const events = await db
      .select()
      .from(trackingEventsTable)
      .where(eq(trackingEventsTable.orderId, orderId))
      .orderBy(desc(trackingEventsTable.createdAt));

    res.json(events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })));
  } catch (err) {
    req.log.error({ err }, "Failed to get tracking events");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/orders/:orderId/email-notifications", requireAuth, async (req, res) => {
  try {
    const businessId = (req as any).businessId;
    const orderId = req.params.orderId as string;

    const order = await db.query.ordersTable.findFirst({
      where: and(eq(ordersTable.id, orderId), eq(ordersTable.businessId, businessId)),
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const notifications = await db
      .select()
      .from(emailNotificationsTable)
      .where(eq(emailNotificationsTable.orderId, orderId))
      .orderBy(desc(emailNotificationsTable.createdAt));

    res.json(
      notifications.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get email notifications");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
