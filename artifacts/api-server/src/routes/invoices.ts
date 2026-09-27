import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, invoicesTable, ordersTable, customersTable, businessesTable, trackingEventsTable, auditLogsTable, jobCostsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { generateId } from "../lib/id";
import { canConfirmInvoicePaid } from "../lib/invoice-workflow";
import { sendInvoiceEmail } from "../lib/email";
import { sendInvoiceSms } from "../lib/invoice-notifications";
import { ensureFinanceSchema } from "./finance";

const router = Router();
const InvoiceBody = z.object({
  orderId: z.string().min(1), subtotal: z.string().min(1),
  additionalCharges: z.string().default("0"), currency: z.string().length(3).default("ZAR"),
  dueDate: z.coerce.date().optional().nullable(), notes: z.string().max(5000).optional().nullable(),
  // Optional internal cost captured at invoicing time. NEVER shown to the
  // customer or on the invoice — it only feeds the Finance tab so the business
  // can see profit per job. Recorded as a single OTHER cost line.
  cost: z.string().optional().nullable(),
});
function invoiceNumber() { return `INV-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${generateId().slice(0,6).toUpperCase()}`; }
function serialize(row:any) { return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v])); }

router.get("/invoices", requireAuth, async (req,res) => {
  const businessId=(req as any).businessId; const conditions:any[]=[eq(invoicesTable.businessId,businessId)];
  if(req.query.customerId)conditions.push(eq(invoicesTable.customerId,String(req.query.customerId)));
  if(req.query.orderId)conditions.push(eq(invoicesTable.orderId,String(req.query.orderId)));
  const rows=await db.select({
    invoice: invoicesTable,
    trackingId: ordersTable.trackingId,
    orderReference: ordersTable.orderReference,
    jobNumber: ordersTable.jobNumber,
    billingStatus: ordersTable.billingStatus,
    customerName: customersTable.fullName,
    customerCompany: customersTable.companyName,
  }).from(invoicesTable)
    .leftJoin(ordersTable, eq(invoicesTable.orderId, ordersTable.id))
    .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
    .where(and(...conditions)).orderBy(desc(invoicesTable.createdAt));
  res.json({data:rows.map(({invoice,...related})=>({...serialize(invoice),...related})),total:rows.length});
});

router.post("/invoices", requireAuth, async (req,res) => {
  try {
    const parsed=InvoiceBody.safeParse(req.body); if(!parsed.success){res.status(400).json({error:"Invalid input",details:parsed.error.issues});return;}
    const businessId=(req as any).businessId,userId=(req as any).userId;
    const order=await db.query.ordersTable.findFirst({where:and(eq(ordersTable.id,parsed.data.orderId),eq(ordersTable.businessId,businessId))});
    if(!order){res.status(404).json({error:"Order not found"});return;}
    const existing=await db.query.invoicesTable.findFirst({where:and(eq(invoicesTable.orderId,order.id),eq(invoicesTable.businessId,businessId))});
    if(existing){res.status(409).json({error:"This order already has an invoice",invoiceId:existing.id});return;}
    const subtotal=Number(parsed.data.subtotal),additional=Number(parsed.data.additionalCharges);
    if(!Number.isFinite(subtotal)||!Number.isFinite(additional)||subtotal<0||additional<0){res.status(400).json({error:"Amounts must be non-negative numbers"});return;}
    // Parse the optional internal cost. Blank/0 means "not recorded now" — the
    // business can still add costs later in the Finance tab.
    const rawCost=parsed.data.cost?.trim();
    const costAmount=rawCost?Number(rawCost):0;
    const hasCost=!!rawCost&&Number.isFinite(costAmount)&&costAmount>0;
    if(rawCost&&(!Number.isFinite(costAmount)||costAmount<0)){res.status(400).json({error:"Cost must be a non-negative number"});return;}
    // The cost line lives in job_costs, which the Finance module self-heals.
    // Ensure it exists before the transaction so a first-ever invoice (before
    // Finance is opened) can still record the cost.
    if(hasCost)await ensureFinanceSchema();
    const invoice=await db.transaction(async tx=>{
      const [created]=await tx.insert(invoicesTable).values({id:generateId(),businessId,invoiceNumber:invoiceNumber(),customerId:order.customerId,orderId:order.id,subtotal:parsed.data.subtotal,additionalCharges:parsed.data.additionalCharges,total:String(subtotal+additional),currency:parsed.data.currency.toUpperCase(),dueDate:parsed.data.dueDate,notes:parsed.data.notes}).returning();
      // Link the invoice + advance billing_status to INVOICED. This NEVER
      // touches current_status (the shipment stage): billing and shipment are
      // independent.
      await tx.update(ordersTable).set({invoiceId:created.id,billingStatus:"INVOICED",updatedAt:new Date()}).where(and(eq(ordersTable.id,order.id),eq(ordersTable.businessId,businessId)));
      // Internal-only cost for the Finance tab (never on the invoice/email).
      if(hasCost){await tx.insert(jobCostsTable).values({id:generateId(),businessId,orderId:order.id,category:"OTHER",amount:costAmount.toFixed(2),currency:parsed.data.currency.toUpperCase(),note:"Recorded at invoicing"});}
      await tx.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"CREATE_INVOICE",entityType:"invoice",entityId:created.id,metadata:{orderId:order.id,invoiceNumber:created.invoiceNumber,...(hasCost?{cost:costAmount.toFixed(2)}:{})}});
      return created;
    });
    res.status(201).json(serialize(invoice));
  } catch(err){req.log.error({err},"Create invoice failed");res.status((err as any)?.code==="23505"?409:500).json({error:(err as any)?.code==="23505"?"This order already has an invoice":"Internal server error"});}
});

router.get("/invoices/:invoiceId",requireAuth,async(req,res)=>{
  const businessId=(req as any).businessId;const invoice=await db.query.invoicesTable.findFirst({where:and(eq(invoicesTable.id,String(req.params.invoiceId)),eq(invoicesTable.businessId,businessId))});
  if(!invoice){res.status(404).json({error:"Invoice not found"});return;}
  const [order,customer,business]=await Promise.all([
    db.query.ordersTable.findFirst({where:and(eq(ordersTable.id,invoice.orderId),eq(ordersTable.businessId,businessId))}),
    db.query.customersTable.findFirst({where:and(eq(customersTable.id,invoice.customerId),eq(customersTable.businessId,businessId))}),
    db.query.businessesTable.findFirst({where:eq(businessesTable.id,businessId)}),
  ]);
  res.json({...serialize(invoice),order:order?serialize(order):null,customer:customer?serialize(customer):null,business:business?serialize(business):null});
});
const UpdateInvoiceBody = z.object({ subtotal:z.coerce.number().nonnegative().optional(), additionalCharges:z.coerce.number().nonnegative().optional(), dueDate:z.coerce.date().nullable().optional(), notes:z.string().max(5000).nullable().optional() });
router.put("/invoices/:invoiceId",requireAuth,async(req,res)=>{
  const parsed=UpdateInvoiceBody.safeParse(req.body);if(!parsed.success){res.status(400).json({error:"Invalid input",details:parsed.error.issues});return;}
  const businessId=(req as any).businessId,userId=(req as any).userId,id=String(req.params.invoiceId);
  const invoice=await db.query.invoicesTable.findFirst({where:and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId))});
  if(!invoice){res.status(404).json({error:"Invoice not found"});return;} if(invoice.status==="paid"){res.status(409).json({error:"Paid invoices cannot be edited"});return;}
  const subtotal=parsed.data.subtotal??Number(invoice.subtotal),additional=parsed.data.additionalCharges??Number(invoice.additionalCharges);
  const [updated]=await db.update(invoicesTable).set({...(parsed.data.subtotal!==undefined?{subtotal:String(subtotal)}:{}),...(parsed.data.additionalCharges!==undefined?{additionalCharges:String(additional)}:{}),...(parsed.data.dueDate!==undefined?{dueDate:parsed.data.dueDate}:{}),...(parsed.data.notes!==undefined?{notes:parsed.data.notes}:{}),total:String(subtotal+additional),updatedAt:new Date()}).where(and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId))).returning();
  await db.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"UPDATE_INVOICE",entityType:"invoice",entityId:id,metadata:{changes:parsed.data}});res.json(serialize(updated));
});
router.delete("/invoices/:invoiceId",requireAuth,async(req,res)=>{
  const businessId=(req as any).businessId,userId=(req as any).userId,id=String(req.params.invoiceId);
  const invoice=await db.query.invoicesTable.findFirst({where:and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId))});
  if(!invoice){res.status(404).json({error:"Invoice not found"});return;} if(invoice.status==="paid"){res.status(409).json({error:"Paid invoices cannot be deleted"});return;}
  await db.transaction(async tx=>{await tx.update(ordersTable).set({invoiceId:null,updatedAt:new Date()}).where(and(eq(ordersTable.id,invoice.orderId),eq(ordersTable.businessId,businessId)));await tx.delete(invoicesTable).where(and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId)));await tx.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"DELETE_INVOICE",entityType:"invoice",entityId:id,metadata:{invoiceNumber:invoice.invoiceNumber,orderId:invoice.orderId}});});res.status(204).send();
});

router.post("/invoices/:invoiceId/send",requireAuth,async(req,res)=>{
  const businessId=(req as any).businessId,userId=(req as any).userId,id=String(req.params.invoiceId);
  const invoice=await db.query.invoicesTable.findFirst({where:and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId))});
  if(!invoice){res.status(404).json({error:"Invoice not found"});return;}
  // This endpoint doubles as both the first send and an explicit resend (no
  // separate resend route exists). sentAt is only ever set by this handler,
  // so its presence BEFORE this call means the invoice was already sent at
  // least once - i.e. this call is a deliberate resend, not a retry.
  const isResend=invoice.sentAt!==null;
  const [order,customer,business]=await Promise.all([
    db.query.ordersTable.findFirst({where:and(eq(ordersTable.id,invoice.orderId),eq(ordersTable.businessId,businessId))}),
    db.query.customersTable.findFirst({where:and(eq(customersTable.id,invoice.customerId),eq(customersTable.businessId,businessId))}),
    db.query.businessesTable.findFirst({where:eq(businessesTable.id,businessId)}),
  ]);
  if(!order||!customer||!business){res.status(409).json({error:"Invoice customer or order details are incomplete"});return;}
  // SaaS branding is always resolved from the authenticated workspace. Prefer
  // its current Branding logo; invoiceLogoUrl remains a legacy fallback for
  // businesses that uploaded a logo before the shared branding profile existed.
  const sent=await sendInvoiceEmail({businessId,senderBusinessName:business.name,customerEmail:customer.email,customerName:customer.fullName,customerAddress:customer.address,customerPhone:customer.phone,invoiceNumber:invoice.invoiceNumber,createdAt:invoice.createdAt,dueDate:invoice.dueDate??invoice.createdAt,description:order.cargoType||order.description||"Cross-border logistics service",serviceDetails:order.serviceRequired||"",quantity:1,subtotal:Number(invoice.subtotal),additionalCharges:Number(invoice.additionalCharges),total:Number(invoice.total),currency:invoice.currency,businessName:business.invoiceLegalName||business.name,supportEmail:business.invoiceEmail||business.supportEmail,businessPhone:business.invoicePhone||business.phone,businessAddress:business.invoiceAddress||business.location,logoUrl:business.businessLogoUrl||business.invoiceLogoUrl,companyRegistration:business.invoiceRegistrationNumber||undefined,taxNumber:business.invoiceTaxNumber,paymentDetails:business.invoicePaymentDetails,paymentTerms:business.invoicePaymentTerms,footerNote:business.invoiceFooterNote,primaryColor:business.primaryBrandColour,orderReference:order.orderReference,jobNumber:order.jobNumber,trackingId:order.trackingId,externalTrackingNumber:order.supplierTrackingNumber,origin:order.origin,destination:order.destination,transportMode:order.transportMode,weight:order.weight});
  if(!sent.success){
    req.log.error({invoiceId:id,businessId,customerId:customer.id,reason:sent.error||"unknown"},"Invoice email delivery failed");
    res.status(502).json({error:sent.error||"Invoice email failed"});return;
  }
  const now=new Date();const [updated]=await db.update(invoicesTable).set({status:"sent",sentAt:now,updatedAt:now}).where(and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId))).returning();
  // Invoice sent -> billing_status AWAITING_PAYMENT (shipment status untouched).
  await db.update(ordersTable).set({billingStatus:"AWAITING_PAYMENT",updatedAt:now}).where(and(eq(ordersTable.id,order.id),eq(ordersTable.businessId,businessId)));
  // SMS confirmation is best-effort and secondary to the invoice email above,
  // which has already succeeded by this point - a provider hiccup here must
  // never fail the invoice-send request or roll back the status update.
  let smsStatus:"sent"|"failed"|"skipped"|"limit_reached"="skipped";
  try{
    const sms=await sendInvoiceSms({orderId:invoice.orderId,customerPhone:customer.phone??undefined,businessName:business.invoiceLegalName||business.name,invoiceNumber:invoice.invoiceNumber,total:Number(invoice.total),currency:invoice.currency,trackingId:order.trackingId,businessPlan:business.plan,businessId,skipDuplicateCheck:isResend});
    smsStatus=sms.smsStatus;
  }catch(err){req.log.error({err,invoiceId:id},"Invoice SMS send failed (non-fatal)");}
  await db.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:"SEND_INVOICE",entityType:"invoice",entityId:id,metadata:{orderId:invoice.orderId,messageId:sent.messageId,customerEmail:customer.email,smsStatus}});
  res.json({...serialize(updated),smsStatus});
});
router.post("/invoices/:invoiceId/pay",requireAuth,async(req,res)=>updateStatus(req,res,"paid"));
async function updateStatus(req:any,res:any,status:"sent"|"paid"){
  const businessId=req.businessId,userId=req.userId,id=String(req.params.invoiceId);
  const invoice=await db.query.invoicesTable.findFirst({where:and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId))});
  if(!invoice){res.status(404).json({error:"Invoice not found"});return;}
  if(invoice.status==="cancelled"||(status==="paid"&&!canConfirmInvoicePaid(invoice.status))){res.status(409).json({error:`Cannot mark ${invoice.status} invoice as ${status}`});return;}
  const now=new Date();
  const updated=await db.transaction(async(tx)=>{
    const [nextInvoice]=await tx.update(invoicesTable).set({status,sentAt:status==="sent"?now:invoice.sentAt,paidAt:status==="paid"?now:invoice.paidAt,paymentConfirmedBy:status==="paid"?userId:invoice.paymentConfirmedBy,updatedAt:now}).where(and(eq(invoicesTable.id,id),eq(invoicesTable.businessId,businessId))).returning();
    // Confirming payment ONLY advances billing_status. It must NEVER move the
    // shipment (current_status) - billing and shipment are independent, so a
    // POSTPAID Job can be delivered long before it's paid, and paying never
    // pushes the cargo forward. (Previously this set current_status =
    // PENDING_TRACKING_NUMBER, which coupled the two - that coupling is removed.)
    await tx.update(ordersTable).set({billingStatus:status==="paid"?"PAID":"AWAITING_PAYMENT",updatedAt:now}).where(and(eq(ordersTable.id,invoice.orderId),eq(ordersTable.businessId,businessId)));
    return nextInvoice;
  });
  await db.insert(auditLogsTable).values({id:generateId(),businessId,userId,action:status==="paid"?"CONFIRM_INVOICE_PAYMENT":"SEND_INVOICE",entityType:"invoice",entityId:id,metadata:{orderId:invoice.orderId,previousStatus:invoice.status,newStatus:status}});
  res.json(serialize(updated));
}
export default router;
