import { expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const order = {
  id: "o1", businessId: "biz-secret", customerId: "customer-secret",
  invoiceId: "invoice-secret", trackingId: "OLY-ABC-2345",
  orderReference: "ORD-1", supplierTrackingNumber: "COURIER-SECRET",
  currentStatus: "PENDING_TRACKING_NUMBER", transportMode: "AIR",
  estimatedDeliveryDate: null, createdAt: new Date(), updatedAt: new Date(),
};
const events = [{ id:"e1", orderId:"o1", status:"RECEIVED_FROM_SUPPLIER", message:"Cargo received", location:"China", createdBy:"staff-secret", createdAt:new Date() }];
const auditValues = vi.fn().mockResolvedValue(undefined);
const mockDb:any = {
  query:{
    ordersTable:{ findFirst:vi.fn().mockResolvedValue(order) },
    businessesTable:{ findFirst:vi.fn().mockResolvedValue({ name:"Freight Co", phone:"0110000000", supportEmail:"help@freight.test" }) },
  },
  select:vi.fn(()=>({from:vi.fn(()=>({where:vi.fn(()=>({orderBy:vi.fn().mockResolvedValue(events)}))}))})),
  insert:vi.fn(()=>({ values:auditValues })),
  execute:vi.fn().mockResolvedValue(undefined),
};
vi.mock("@workspace/db", async(importOriginal)=>({...(await importOriginal<any>()),db:mockDb}));

it("does not require the tracking database for unrelated API routes", async () => {
  const app = express();
  app.use((await import("../routes/public-tracking")).default);
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  mockDb.execute.mockClear();
  const res = await request(app).get("/healthz");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
  expect(mockDb.execute).not.toHaveBeenCalled();
});

it("keeps customer, invoice, supplier and staff data out of public tracking", async () => {
  const app=express();app.use((await import("../routes/public-tracking")).default);
  const res=await request(app).get("/public/track/OLY-ABC-2345");
  expect(res.status).toBe(200);
  for (const privateField of ["businessId","customerId","invoiceId","supplierTrackingNumber","createdBy"]) {
    expect(JSON.stringify(res.body)).not.toContain(privateField);
  }
  expect(res.body.trackingId).toBe("OLY-ABC-2345");
  expect(res.body.currentStatus).toBe("ORDER_CONFIRMED");
  expect(res.body.statusLabel).toBe("Job Confirmed");
  expect(JSON.stringify(res.body)).not.toContain("PENDING_TRACKING_NUMBER");
});

it("records a customer reschedule request without changing shipment status", async () => {
  const app=express();app.use(express.json());app.use((await import("../routes/public-tracking")).default);
  const res=await request(app).post("/public/track/OLY-ABC-2345/requests").send({type:"reschedule",requestedDate:"2026-08-20",note:"Morning please"});
  expect(res.status).toBe(201);
  expect(res.body.success).toBe(true);
  expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
    action:"CUSTOMER_RESCHEDULE_REQUEST",
    entityType:"order",
    entityId:"o1",
    metadata:expect.objectContaining({requestedDate:"2026-08-20",note:"Morning please"}),
  }));
});
