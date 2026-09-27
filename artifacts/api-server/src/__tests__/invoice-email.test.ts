import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

import { sendInvoiceEmail, sendStatusEmail, sendPasswordResetEmail, type SendInvoiceEmailParams } from "../lib/email";

const invoice: SendInvoiceEmailParams = {
  businessId: "business-acme",
  customerEmail: "customer@example.com", customerName: "Thabo Nkosi",
  customerAddress: "Johannesburg", customerPhone: "+27 71 234 5678",
  invoiceNumber: "INV-20260822-TEST01", createdAt: new Date("2026-08-22T10:00:00Z"),
  dueDate: new Date("2026-08-29T10:00:00Z"), description: "Handbags",
  serviceDetails: "Air freight", quantity: 1, subtotal: 637.23,
  additionalCharges: 22, total: 659.23, currency: "ZAR",
  // This fixture represents whichever tenant is currently authenticated. The
  // image is local test data only; production receives the workspace logo URL.
  businessName: "Acme Freight", supportEmail: "accounts@acmefreight.test",
  logoUrl: `data:image/png;base64,${readFileSync(new URL("../../../olyxee-admin/public/favicon.png", import.meta.url)).toString("base64")}`,
  paymentDetails: "Bank: FNB\nAccount: 62123456789", paymentTerms: "Due within 7 days",
  primaryColor: "#146C94", jobNumber: "JOB-20260822-X7KM",
  origin: "Shenzhen, China", destination: "Johannesburg, South Africa",
  transportMode: "AIR", weight: "3.2 kg",
};

describe("invoice email delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM_ADDRESS = "notifications@olyxee.com";
    mocks.send.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  it("sends a visible message and the current PDF attachment together", async () => {
    const result = await sendInvoiceEmail(invoice);

    expect(result).toEqual({ success: true, messageId: "email_1" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const payload = mocks.send.mock.calls[0][0];
    expect(payload.from).toBe("Acme Freight <notifications@olyxee.com>");
    expect(payload.replyTo).toBe("accounts@acmefreight.test");
    expect(payload.html).toContain("Hi Thabo Nkosi,");
    expect(payload.html).toContain("Please find your invoice attached to this email as a PDF");
    // Data-URL logos belong in the attached PDF, not the email HTML. Large
    // inline base64 images are rejected or stripped by email providers.
    expect(payload.html).not.toContain("data:image/");
    expect(payload.html).toContain("Acme Freight");
    expect(payload.html).not.toContain("Payment details");
    expect(payload.html).not.toContain("INV-20260822-TEST01");
    expect(payload.html).not.toContain("JOB-20260822-X7KM");
    expect(payload.subject).toBe("Your invoice from Acme Freight");
    expect(payload.text).toContain("Please find your invoice attached to this email as a PDF");
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("INV-20260822-TEST01.pdf");
    expect(Buffer.isBuffer(payload.attachments[0].content)).toBe(true);
    expect(payload.attachments[0].content.subarray(0, 4).toString()).toBe("%PDF");
    expect(payload.attachments[0].content.toString("latin1")).toContain("/Subtype /Image");
  });

  it("does not let an invalid tenant reply-to address block delivery", async () => {
    const result = await sendInvoiceEmail({ ...invoice, supportEmail: "not configured" });

    expect(result).toEqual({ success: true, messageId: "email_1" });
    const payload = mocks.send.mock.calls[0][0];
    expect(payload.replyTo).toBe("notifications@olyxee.com");
    expect(payload.attachments[0].content.toString("latin1")).toContain("/Subtype /Image");
  });

  it("includes available tenant collection details in the final status email", async () => {
    const result = await sendStatusEmail({
      businessId: "business-acme",
      customerEmail: "customer@example.com",
      customerName: "Thabo Nkosi",
      trackingId: "ACM-001-2026",
      status: "Delivered / Ready for Collection",
      statusMessage: null,
      trackingLink: "https://logistics.example.com/track?code=ACM-001-2026",
      businessTrackingLink: "https://acmefreight.test/track-shipment/?code=ACM-001-2026",
      businessName: "Acme Freight",
      businessAddress: "12 Cargo Road, Johannesburg",
      businessPhone: "+27 11 555 0100",
      supportEmail: "help@acmefreight.test",
    });

    expect(result.success).toBe(true);
    const payload = mocks.send.mock.calls[0][0];
    expect(payload.subject).toContain("Your shipment is ready for collection");
    expect(payload.html).toContain("Collection / Contact Details");
    expect(payload.html).toContain("12 Cargo Road, Johannesburg");
    expect(payload.html).toContain("+27 11 555 0100");
    expect(payload.html).toContain("help@acmefreight.test");
    expect(payload.html).toContain("View tracking on Acme Freight");
    expect(payload.html).toContain("https://acmefreight.test/track-shipment/?code=ACM-001-2026");
    expect(payload.from).toBe("Acme Freight <notifications@olyxee.com>");
    expect(payload.replyTo).toBe("help@acmefreight.test");
  });

  it("isolates invoice sender, reply-to and content across two businesses", async () => {
    await sendInvoiceEmail(invoice);
    await sendInvoiceEmail({
      ...invoice, businessId: "business-fast", businessName: "Fast Cargo",
      senderBusinessName: "Fast Cargo", supportEmail: "team@fastcargo.test",
      invoiceNumber: "INV-FAST-01",
    });
    const [a, b] = mocks.send.mock.calls.map(([payload]) => payload);
    expect(a.from).toBe("Acme Freight <notifications@olyxee.com>");
    expect(a.replyTo).toBe("accounts@acmefreight.test");
    expect(b.from).toBe("Fast Cargo <notifications@olyxee.com>");
    expect(b.replyTo).toBe("team@fastcargo.test");
    expect(b.html).toContain("Fast Cargo");
    expect(b.html).not.toContain("Acme Freight");
    expect(b.text).not.toContain("Acme Freight");
    expect(b.attachments[0].content.toString("latin1")).not.toContain("Acme Freight");
  });

  it("uses the current business for password resets, not a fixed platform brand", async () => {
    const result = await sendPasswordResetEmail({
      businessId: "business-fast", businessName: "Fast Cargo",
      supportEmail: "team@fastcargo.test", to: "staff@fastcargo.test",
      name: "Staff", resetLink: "https://logistics.olyxee.com/reset-password?token=test",
      expiresInMinutes: 30,
    });
    expect(result.success).toBe(true);
    const payload = mocks.send.mock.calls[0][0];
    expect(payload.from).toBe("Fast Cargo <notifications@olyxee.com>");
    expect(payload.replyTo).toBe("team@fastcargo.test");
    expect(payload.subject).toBe("Reset your Fast Cargo password");
    expect(payload.html).not.toContain("Acme Freight");
  });

  it("uses safe display and reply-to fallbacks when business fields are missing", async () => {
    await sendStatusEmail({
      businessId: "business-no-name", businessName: "", supportEmail: "",
      customerEmail: "customer@example.test", customerName: "Client",
      trackingId: "TRACK-1", status: "In transit", statusMessage: null,
      trackingLink: "https://logistics.olyxee.com/track?code=TRACK-1",
    });
    const payload = mocks.send.mock.calls[0][0];
    expect(payload.from).toBe("Logistics <notifications@olyxee.com>");
    expect(payload.replyTo).toBe("notifications@olyxee.com");
  });

  it("keeps two businesses' tracking updates separate", async () => {
    const status = {
      customerEmail: "customer@example.test", customerName: "Client",
      trackingId: "TRACK-1", status: "In transit", statusMessage: null,
      trackingLink: "https://logistics.olyxee.com/track?code=TRACK-1",
    };
    await sendStatusEmail({
      ...status, businessId: "business-acme", businessName: "Acme Freight",
      supportEmail: "help@acmefreight.test",
    });
    await sendStatusEmail({
      ...status, businessId: "business-fast", businessName: "Fast Cargo",
      supportEmail: "team@fastcargo.test",
    });
    const [a, b] = mocks.send.mock.calls.map(([payload]) => payload);
    expect(a.from).toBe("Acme Freight <notifications@olyxee.com>");
    expect(a.replyTo).toBe("help@acmefreight.test");
    expect(b.from).toBe("Fast Cargo <notifications@olyxee.com>");
    expect(b.replyTo).toBe("team@fastcargo.test");
    expect(b.html).not.toContain("Acme Freight");
    expect(b.text).not.toContain("Acme Freight");
  });

  it("fails explicitly when the sender address is missing or malformed", async () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    expect(await sendInvoiceEmail(invoice)).toMatchObject({ success: false, error: "Email sender not configured" });
    expect(mocks.send).not.toHaveBeenCalled();
    process.env.EMAIL_FROM_ADDRESS = "Wrong Brand <notifications@olyxee.com>";
    expect(await sendStatusEmail({
      businessId: "business-acme", businessName: "Acme Freight", supportEmail: "",
      customerEmail: "customer@example.test", customerName: "Client",
      trackingId: "TRACK-1", status: "In transit", statusMessage: null,
      trackingLink: "https://logistics.olyxee.com/track?code=TRACK-1",
    })).toMatchObject({ success: false, error: "Email sender not configured" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails explicitly when the API key is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendPasswordResetEmail({
      businessId: "business-acme", businessName: "Acme Freight",
      to: "staff@example.test", name: "Staff",
      resetLink: "https://logistics.olyxee.com/reset-password?token=test",
      expiresInMinutes: 30,
    });
    expect(result).toMatchObject({ success: false, error: "Email provider not configured" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("reports Resend's domain verification failure without sending to another tenant", async () => {
    mocks.send.mockResolvedValueOnce({ data: null, error: {
      statusCode: 403, name: "validation_error", message: "The domain is not verified.",
    } });
    const result = await sendInvoiceEmail(invoice);
    expect(result).toMatchObject({ success: false, error: "The domain is not verified." });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("handles an exception from Resend without leaking email contents", async () => {
    mocks.send.mockRejectedValueOnce(new Error("Temporary service failure"));
    expect(await sendPasswordResetEmail({
      businessId: "business-acme", businessName: "Acme Freight",
      to: "staff@example.test", name: "Staff",
      resetLink: "https://logistics.olyxee.com/reset-password?token=test",
      expiresInMinutes: 30,
    })).toMatchObject({ success: false, error: "Failed to send email" });
  });
});
