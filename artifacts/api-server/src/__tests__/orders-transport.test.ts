import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn(async () => undefined),
  query: {
    ordersTable: { findFirst: vi.fn() },
    customersTable: { findFirst: vi.fn() },
    businessesTable: { findFirst: vi.fn() },
    invoicesTable: { findFirst: vi.fn() },
  },
};

vi.mock("@workspace/db", () => ({
  db: mockDb,
  ordersTable: { trackingId: "trackingId" },
  customersTable: {},
  trackingEventsTable: {},
  emailNotificationsTable: {},
  smsNotificationsTable: {},
  auditLogsTable: {},
  businessesTable: {},
  invoicesTable: { id: "id", businessId: "businessId" },
  jobCostsTable: {},
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).businessId = "biz_test";
    (req as any).userId = "user_test";
    next();
  },
}));

let idCounter = 0;
vi.mock("../lib/id", () => ({
  generateId: () => `test-id-${++idCounter}`,
  generateTrackingId: () => `OLY-AAA-BBBB`,
  resolveTrackingPrefix: () => "OLY",
  companyAcronym: (name: string) => name.includes("Freight Solutions Logistics") ? "FSL" : "JOB",
}));

vi.mock("../lib/email", () => ({
  sendStatusEmail: vi.fn(async () => ({ success: true, messageId: "m1" })),
  buildEmailBody: vi.fn(() => ({ subject: "s", body: "b" })),
  sendInvoiceEmail: vi.fn(async () => ({ success: false, error: "test provider disabled" })),
}));
vi.mock("../lib/email-usage", () => ({
  getMonthlyEmailUsage: vi.fn(async () => 0),
}));
const mockSendOrderSms = vi.fn(async (..._args: unknown[]) => ({ status: "skipped" }));
vi.mock("../lib/order-notifications", () => ({
  sendOrderSms: (...args: unknown[]) => mockSendOrderSms(...args),
}));
vi.mock("../lib/notifications", () => ({
  recordNotification: vi.fn(async () => undefined),
}));
vi.mock("../lib/order-fsm", () => ({
  FSM_ORDER_STATUSES: [],
  transitionOrder: vi.fn(),
  findStuckOrders: vi.fn(async () => []),
  ConcurrentTransitionError: class extends Error {},
}));

async function buildApp() {
  const app = express();
  app.use(express.json());
  // Production wires req.log via pino-http; stub it here so routes that call
  // req.log.error(...) directly (matching this file's real logging
  // convention) don't crash the bare test harness when a catch block runs.
  app.use((req, _res, next) => {
    (req as any).log = console;
    next();
  });
  const { default: router } = await import("../routes/orders");
  app.use(router);
  return app;
}

const CUSTOMER = { id: "cust_1", businessId: "biz_test", fullName: "Jane", email: "j@x.com" };
const LOGISTICS_BIZ = { id: "biz_test", name: "Freight Co", slug: "freight", industry: "Logistics Company", websiteUrl: "", trackingIdPrefix: "OLY" };
const RETAIL_BIZ = { ...LOGISTICS_BIZ, industry: "Retail" };

function insertChain(returning: unknown[]) {
  return { values: vi.fn(() => ({ returning: vi.fn(async () => returning) })) };
}
// Insert without .returning() (tracking event / audit log) — values() resolves.
function insertChainPlain() {
  const values = vi.fn(async () => undefined) as any;
  values.mockImplementation(() => {
    const p: any = Promise.resolve(undefined);
    p.returning = vi.fn(async () => [{}]);
    return p;
  });
  return { values };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.invoicesTable.findFirst.mockResolvedValue({ id: "inv_1", status: "paid" });
});

function mockInvoiceTransaction() {
  mockDb.transaction.mockImplementation(async (fn: any) => fn({
    insert: vi.fn(() => insertChainPlain()),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  }));
}

describe("POST /orders — transport mode requirements", () => {
  it("suggests the next company-acronym Job Number", async () => {
    mockDb.query.businessesTable.findFirst.mockResolvedValue({
      ...LOGISTICS_BIZ,
      name: "Freight Solutions Logistics (Pty) Ltd",
    });
    const jobs = Array.from({ length: 22 }, (_, index) => ({
      jobNumber: `FSL-${String(index + 1).padStart(4, "0")}-2026`,
    }));
    mockDb.select.mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn(async () => jobs) })),
    } as any);
    const app = await buildApp();

    const res = await request(app).get("/orders/next-job-number");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ acronym: "FSL", sequence: 23, jobNumber: "FSL-0023-2026" });
  });

  it("rejects cross-border order creation without transportMode", async () => {
    mockDb.query.customersTable.findFirst.mockResolvedValue(CUSTOMER);
    mockDb.query.businessesTable.findFirst.mockResolvedValue(LOGISTICS_BIZ);
    const app = await buildApp();
    const res = await request(app).post("/orders").send({ customerId: "cust_1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid input");
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["transportMode"] })]),
    );
  });

  it("accepts a cross-border mode regardless of legacy industry metadata", async () => {
    mockDb.query.customersTable.findFirst.mockResolvedValue(CUSTOMER);
    mockDb.query.businessesTable.findFirst.mockResolvedValue(RETAIL_BIZ);
    const inserted = {
      id: "ord_retail_metadata",
      businessId: "biz_test",
      customerId: "cust_1",
      trackingId: "OLY-AAA-BBBB",
      currentStatus: "ORDER_CONFIRMED",
      transportMode: "SEA",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockDb.insert
      .mockReturnValueOnce(insertChain([inserted]) as any)
      .mockReturnValue(insertChainPlain() as any);
    mockInvoiceTransaction();
    const app = await buildApp();
    const res = await request(app)
      .post("/orders")
      .send({ customerId: "cust_1", jobNumber: "JOB-1", billingType: "PREPAID", transportMode: "SEA", cargoType: "Handbags", serviceRequired: "Customs", weight: "1.5 kg", invoiceSubtotal: "600" });
    expect(res.status).toBe(201);
    expect(res.body.transportMode).toBe("SEA");
  });

  it("rejects invalid transportMode values at the schema layer", async () => {
    mockDb.query.customersTable.findFirst.mockResolvedValue(CUSTOMER);
    mockDb.query.businessesTable.findFirst.mockResolvedValue(LOGISTICS_BIZ);
    const app = await buildApp();
    const res = await request(app)
      .post("/orders")
      .send({ customerId: "cust_1", transportMode: "ROAD" });
    expect(res.status).toBe(400);
  });

  it("creates a SEA logistics order starting at ORDER_CONFIRMED", async () => {
    mockDb.query.customersTable.findFirst.mockResolvedValue(CUSTOMER);
    mockDb.query.businessesTable.findFirst.mockResolvedValue(LOGISTICS_BIZ);
    const inserted = {
      id: "ord_1",
      businessId: "biz_test",
      customerId: "cust_1",
      trackingId: "OLY-AAA-BBBB",
      orderReference: null,
      description: null,
      currentStatus: "ORDER_CONFIRMED",
      transportMode: "SEA",
      estimatedDeliveryDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockDb.insert
      .mockReturnValueOnce(insertChain([inserted]) as any) // order insert
      .mockReturnValue(insertChainPlain() as any); // tracking event + audit
    mockInvoiceTransaction();
    const app = await buildApp();
    const res = await request(app)
      .post("/orders")
      .send({ customerId: "cust_1", jobNumber: "JOB-2", billingType: "PREPAID", transportMode: "SEA", cargoType: "Handbags", serviceRequired: "Customs", weight: "1.5 kg", invoiceSubtotal: "600" });
    expect(res.status).toBe(201);
    expect(res.body.currentStatus).toBe("ORDER_CONFIRMED");
    expect(res.body.transportMode).toBe("SEA");
  });

  it("records the optional internal Job cost during billing setup", async () => {
    mockDb.query.customersTable.findFirst.mockResolvedValue(CUSTOMER);
    mockDb.query.businessesTable.findFirst.mockResolvedValue(LOGISTICS_BIZ);
    const inserted = {
      id: "ord_with_cost", businessId: "biz_test", customerId: "cust_1",
      trackingId: "OLY-AAA-BBBB", jobNumber: "JOB-COST-1",
      currentStatus: "ORDER_CONFIRMED", transportMode: "AIR",
      createdAt: new Date(), updatedAt: new Date(),
    };
    mockDb.insert.mockReturnValueOnce(insertChain([inserted]) as any);
    const costValues = vi.fn(async () => undefined);
    const txInsert = vi.fn()
      .mockReturnValueOnce({ values: costValues })
      .mockReturnValue(insertChainPlain());
    mockDb.transaction.mockImplementation(async (fn: any) => fn({ insert: txInsert }));
    const app = await buildApp();

    const res = await request(app).post("/orders").send({
      customerId: "cust_1", jobNumber: "JOB-COST-1", billingType: "POSTPAID",
      transportMode: "AIR", cargoType: "Electronics", serviceRequired: "Freight",
      weight: "4 kg", jobCost: "325.50",
    });

    expect(res.status).toBe(201);
    expect(costValues).toHaveBeenCalledWith(expect.objectContaining({
      orderId: "ord_with_cost", amount: "325.50", currency: "ZAR",
    }));
  });

  it("requires transport mode even for legacy non-logistics business records", async () => {
    mockDb.query.customersTable.findFirst.mockResolvedValue(CUSTOMER);
    mockDb.query.businessesTable.findFirst.mockResolvedValue(RETAIL_BIZ);
    const app = await buildApp();
    const res = await request(app).post("/orders").send({ customerId: "cust_1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid input");
  });
});

describe("POST /orders/:orderId/status — transport-aware validation", () => {
  const SEA_ORDER = {
    id: "ord_1",
    businessId: "biz_test",
    customerId: "cust_1",
    trackingId: "OLY-AAA-BBBB",
    currentStatus: "ORDER_CONFIRMED",
    billingType: "PREPAID",
    invoiceId: "inv_1",
    supplierTrackingNumber: "CN-TRACK-1",
    transportMode: "SEA",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("blocks tracking updates while the invoice is awaiting payment", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue(SEA_ORDER);
    mockDb.query.invoicesTable.findFirst.mockResolvedValue({ id: "inv_1", status: "sent" });
    const app = await buildApp();
    const res = await request(app)
      .post("/orders/ord_1/status")
      .send({ status: "COLLECTED_FROM_SUPPLIER" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Payment must be confirmed/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("does not gate tracking updates on the optional supplier tracking number", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({ ...SEA_ORDER, currentStatus: "PENDING_TRACKING_NUMBER", supplierTrackingNumber: null });
    mockDb.query.customersTable.findFirst.mockResolvedValue(null);
    mockDb.query.businessesTable.findFirst.mockResolvedValue({ ...LOGISTICS_BIZ, plan: "beta", monthlyEmailLimit: 500 });
    mockDb.insert.mockReturnValue(insertChainPlain() as any);
    const updated = { ...SEA_ORDER, currentStatus: "RECEIVED_AT_WAREHOUSE", supplierTrackingNumber: null };
    mockDb.transaction.mockImplementation(async (fn: any) => fn({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: "tev_optional", status: "RECEIVED_AT_WAREHOUSE", createdAt: new Date() }]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [updated]) })) })) })),
    }));
    const app = await buildApp();
    const res = await request(app).post("/orders/ord_1/status").send({ status: "RECEIVED_AT_WAREHOUSE" });
    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  it("keeps pre-invoice legacy orders updateable after the rollout", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({ ...SEA_ORDER, invoiceId: null, supplierTrackingNumber: null });
    mockDb.query.customersTable.findFirst.mockResolvedValue(null);
    mockDb.query.businessesTable.findFirst.mockResolvedValue({ ...LOGISTICS_BIZ, plan: "beta", monthlyEmailLimit: 500 });
    mockDb.insert.mockReturnValue(insertChainPlain() as any);
    const updated = { ...SEA_ORDER, invoiceId: null, currentStatus: "COLLECTED_FROM_SUPPLIER" };
    mockDb.transaction.mockImplementation(async (fn: any) => fn({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: "tev_legacy", status: "COLLECTED_FROM_SUPPLIER", createdAt: new Date() }]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [updated]) })) })) })),
    }));
    const app = await buildApp();
    const res = await request(app).post("/orders/ord_1/status").send({ status: "COLLECTED_FROM_SUPPLIER" });
    expect(res.status).toBe(200);
  });

  it("rejects a status outside the order's mode flow (422)", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({
      ...SEA_ORDER,
      transportMode: "AIR",
      currentStatus: "IN_TRANSIT",
    });
    const app = await buildApp();
    const res = await request(app)
      .post("/orders/ord_1/status")
      .send({ status: "VESSEL_DEPARTED" });
    expect(res.status).toBe(422);
    expect(res.body.allowedStatuses).toContain("IN_TRANSIT");
    expect(res.body.allowedStatuses).not.toContain("VESSEL_DEPARTED");
  });

  it("rejects logistics statuses on orders without a transport mode (legacy-safe)", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({
      ...SEA_ORDER,
      transportMode: null,
      currentStatus: "Order received",
    });
    const app = await buildApp();
    const res = await request(app)
      .post("/orders/ord_1/status")
      .send({ status: "VESSEL_DEPARTED" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no transport mode/);
  });

  it("refuses further updates once DELIVERED (terminal)", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({
      ...SEA_ORDER,
      currentStatus: "DELIVERED",
    });
    const app = await buildApp();
    const res = await request(app)
      .post("/orders/ord_1/status")
      .send({ status: "OUT_FOR_DELIVERY" });
    expect(res.status).toBe(409);
  });

  it("prevents moving a SEA shipment backwards", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({ ...SEA_ORDER, currentStatus: "ARRIVED_AT_DESTINATION" });
    const app = await buildApp();
    const res = await request(app).post("/orders/ord_1/status").send({ status: "LOADING" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot move backwards/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("accepts a valid SEA transition and records a tracking event", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({ ...SEA_ORDER, currentStatus: "RECEIVED_AT_WAREHOUSE" });
    mockDb.query.customersTable.findFirst.mockResolvedValue(null);
    mockDb.query.businessesTable.findFirst.mockResolvedValue({
      ...LOGISTICS_BIZ,
      plan: "beta",
      monthlyEmailLimit: 500,
    });
    mockDb.insert.mockReturnValue(insertChainPlain() as any);
    const updated = { ...SEA_ORDER, currentStatus: "PREPARING_FOR_SHIPMENT" };
    const txInsert = vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: "tev_1", status: "PREPARING_FOR_SHIPMENT", createdAt: new Date() }]) })),
    }));
    const txUpdate = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [updated]) })) })),
    }));
    mockDb.transaction.mockImplementation(async (fn: any) =>
      fn({ insert: txInsert, update: txUpdate }),
    );
    const app = await buildApp();
    const res = await request(app)
      .post("/orders/ord_1/status")
      .send({ status: "PREPARING_FOR_SHIPMENT" });
    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  it("still returns 200 with the already-committed status update when the SMS layer throws", async () => {
    mockDb.query.ordersTable.findFirst.mockResolvedValue({ ...SEA_ORDER, currentStatus: "RECEIVED_AT_WAREHOUSE" });
    // No customer looked up (matches the other passing transition tests
    // above) - this test only needs the SMS-send call site to be reached and
    // to throw, which happens regardless of customer/email details.
    mockDb.query.customersTable.findFirst.mockResolvedValue(null);
    mockDb.query.businessesTable.findFirst.mockResolvedValue({
      ...LOGISTICS_BIZ,
      plan: "beta",
      monthlyEmailLimit: 500,
    });
    mockDb.insert.mockReturnValue(insertChainPlain() as any);
    const updated = { ...SEA_ORDER, currentStatus: "PREPARING_FOR_SHIPMENT" };
    const txInsert = vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: "tev_2", status: "PREPARING_FOR_SHIPMENT", createdAt: new Date() }]) })),
    }));
    const txUpdate = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [updated]) })) })),
    }));
    mockDb.transaction.mockImplementation(async (fn: any) =>
      fn({ insert: txInsert, update: txUpdate }),
    );
    // Simulate an unexpected failure inside the SMS layer (e.g. a DB error
    // from the dedup check) - the order status update has already committed
    // above by this point and must not be reported as a failed request.
    mockSendOrderSms.mockRejectedValueOnce(new Error("boom - simulated SMS layer crash"));

    const app = await buildApp();
    const res = await request(app)
      .post("/orders/ord_1/status")
      .send({ status: "PREPARING_FOR_SHIPMENT" });

    expect(res.status).toBe(200);
    expect(res.body.order.currentStatus).toBe("PREPARING_FOR_SHIPMENT");
    expect(res.body.smsStatus).toBe("skipped");
    expect(mockDb.transaction).toHaveBeenCalled();
  });
});
