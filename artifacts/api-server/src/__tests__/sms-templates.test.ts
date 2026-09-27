import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/order-statuses", () => ({
  statusCopy: (status: string) => ({
    headline: status === "DELIVERED" ? "Your order has been delivered" : `Your order is ${status}`,
    intro: "intro",
  }),
}));

import { buildSmsBody, buildInvoiceSmsBody } from "../lib/sms-templates";

describe("buildSmsBody (order status SMS)", () => {
  it("includes business name, tracking id, status and link", () => {
    const body = buildSmsBody({
      businessName: "Acme Freight",
      trackingId: "ACM-001-2026",
      status: "DELIVERED",
      statusMessage: null,
      trackingLink: "https://track.example.com/ACM-001-2026",
      customerPhone: "+27821234567",
    });

    expect(body).toContain("Acme Freight: ACM-001-2026");
    expect(body).toContain("has been delivered");
    expect(body).toContain("https://track.example.com/ACM-001-2026");
  });

  it("includes a short admin note when present", () => {
    const body = buildSmsBody({
      businessName: "Acme",
      trackingId: "ACM-1",
      status: "IN_TRANSIT",
      statusMessage: "Held at customs",
      trackingLink: "",
      customerPhone: "+27821234567",
    });

    expect(body).toContain("Held at customs");
  });

  it("truncates a long admin note", () => {
    const longNote = "x".repeat(200);
    const body = buildSmsBody({
      businessName: "Acme",
      trackingId: "ACM-1",
      status: "IN_TRANSIT",
      statusMessage: longNote,
      trackingLink: "",
      customerPhone: "+27821234567",
    });

    expect(body).not.toContain(longNote);
    expect(body).toContain("...");
  });

  it("never produces a message longer than 160 characters", () => {
    const body = buildSmsBody({
      businessName: "A Very Long Freight Forwarding Company Name Pty Ltd",
      trackingId: "ACM-0000000001-2026",
      status: "IN_TRANSIT",
      statusMessage: "This is a moderately long administrative note about the shipment status",
      trackingLink: "https://tracking.example.com/very/long/path/to/the/order/ACM-0000000001-2026",
      customerPhone: "+27821234567",
    });

    expect(body.length).toBeLessThanOrEqual(160);
  });

  it("omits the note section entirely when there is no message", () => {
    const body = buildSmsBody({
      businessName: "Acme",
      trackingId: "ACM-1",
      status: "IN_TRANSIT",
      statusMessage: "   ",
      trackingLink: "",
      customerPhone: "+27821234567",
    });

    expect(body).toBe("Acme: ACM-1 | order is IN_TRANSIT");
  });
});

describe("buildInvoiceSmsBody", () => {
  it("includes the invoice number and amount due", () => {
    const body = buildInvoiceSmsBody({
      businessName: "Acme Freight",
      invoiceNumber: "INV-20260101-ABC123",
      total: 1234.5,
      currency: "ZAR",
      trackingId: "ACM-001-2026",
    });

    expect(body).toContain("Acme Freight: Invoice INV-20260101-ABC123");
    expect(body).toContain("ZAR 1234.50");
    expect(body).toContain("Ref: ACM-001-2026");
  });

  it("omits the reference line when no tracking id is given", () => {
    const body = buildInvoiceSmsBody({
      businessName: "Acme",
      invoiceNumber: "INV-1",
      total: 10,
      currency: "ZAR",
    });

    expect(body).not.toContain("Ref:");
  });

  it("never produces a message longer than 160 characters", () => {
    const body = buildInvoiceSmsBody({
      businessName: "A Very Long Freight Forwarding Company Name Pty Ltd",
      invoiceNumber: "INV-20260101-VERYLONGINVOICENUMBER123456",
      total: 999999.99,
      currency: "ZAR",
      trackingId: "ACM-0000000001-2026",
    });

    expect(body.length).toBeLessThanOrEqual(160);
  });
});
