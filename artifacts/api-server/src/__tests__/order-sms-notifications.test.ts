import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
const dbState = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
}));
const inserted = dbState.inserted;

vi.mock("@workspace/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        dbState.inserted.push(row);
        return { returning: vi.fn(async () => [{ ...row }]) };
      }),
    })),
  },
  smsNotificationsTable: {},
  ordersTable: {},
}));

vi.mock("../lib/id", () => {
  let n = 0;
  return { generateId: () => `sms-notif-${++n}` };
});

const smsMock = vi.hoisted(() => ({
  sendSms: vi.fn(),
  isSmsConfigured: vi.fn(),
}));
vi.mock("../lib/sms", () => smsMock);

const dedupMock = vi.hoisted(() => ({ findRecentDuplicateSms: vi.fn() }));
vi.mock("../lib/sms-dedup", () => dedupMock);

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../lib/logger", () => ({ logger: loggerMock }));

const usageMock = vi.hoisted(() => ({ getMonthlySmsUsage: vi.fn() }));
vi.mock("../lib/sms-usage", () => usageMock);

import { sendOrderSms } from "../lib/order-notifications";

const BASE_PARAMS = {
  orderId: "order-1",
  customerPhone: "+27712345678",
  businessName: "Acme Freight",
  trackingId: "ACM-001-2026",
  status: "In transit",
  statusMessage: null,
  trackingLink: "https://track.example.com/ACM-001-2026",
  businessId: "biz-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  dedupMock.findRecentDuplicateSms.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendOrderSms — trigger conditions", () => {
  it("skips entirely (no DB write, no provider call) when the customer has no phone number", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);

    const result = await sendOrderSms({ ...BASE_PARAMS, customerPhone: undefined, businessPlan: "beta" });

    expect(result).toEqual({
      smsStatus: "skipped",
      smsNotificationId: undefined,
      smsUsage: undefined,
      smsLimit: undefined,
    });
    expect(smsMock.sendSms).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { orderId: "order-1" },
      "Order SMS skipped: customer phone number is missing",
    );
  });

  it("skips entirely when SMS is not configured (flag off or missing credentials)", async () => {
    smsMock.isSmsConfigured.mockReturnValue(false);

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("skipped");
    expect(smsMock.sendSms).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe("sendOrderSms — plan SMS limits", () => {
  it.each(["beta", "free", "pro", "business"] as const)(
    "plan '%s' can send without a monthly SMS quota",
    async (plan) => {
      smsMock.isSmsConfigured.mockReturnValue(true);
      usageMock.getMonthlySmsUsage.mockResolvedValue(50);
      smsMock.sendSms.mockResolvedValue({
        success: true,
        providerMessageId: "msg-1",
      });

      const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: plan });

      expect(result.smsStatus).toBe("sent");
      expect(result.smsLimit).toBeNull();
      expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        status: "sent",
        providerMessageId: "msg-1",
      });
    },
  );
});

describe("sendOrderSms — recipient, template content, and single-send guarantee", () => {
  beforeEach(() => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
  });

  it("sends to the customer's phone number, with business/tracking/status in the body, exactly once", async () => {
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-42" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
    const call = smsMock.sendSms.mock.calls[0][0];
    expect(call.to).toBe("+27712345678");
    expect(call.body).toContain("Acme Freight");
    expect(call.body).toContain("ACM-001-2026");
    // sms-templates.ts runs `status` through statusCopy() to get friendly
    // customer copy rather than sending the raw status string verbatim -
    // confirm that translation actually happened rather than asserting on
    // the literal input status.
    expect(call.body).not.toBe("");
    expect(call.body.toLowerCase()).toContain("move"); // "In transit" -> "package is on the move"
    expect(call.body).toContain("https://track.example.com/ACM-001-2026");

    expect(result.smsStatus).toBe("sent");
    expect(result.smsUsage).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      orderId: "order-1",
      customerPhone: "+27712345678",
      status: "sent",
      providerMessageId: "msg-42",
    });
  });

  it("includes an admin status message in the SMS body when provided", async () => {
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-1" });

    await sendOrderSms({
      ...BASE_PARAMS,
      businessPlan: "beta",
      statusMessage: "Delayed due to customs inspection",
    });

    const call = smsMock.sendSms.mock.calls[0][0];
    expect(call.body).toContain("Delayed due to customs inspection");
  });

  it("records a 'failed' notification (not a thrown error) when the provider call fails", async () => {
    smsMock.sendSms.mockResolvedValue({ success: false, error: "SMSPortal send failed (500)" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("failed");
    expect(result.smsUsage).toBe(0); // usage only increments on confirmed sent
    expect(inserted[0]).toMatchObject({ status: "failed", providerMessageId: null });
  });
});

describe("sendOrderSms — duplicate protection", () => {
  it("skips an identical message that was recently sent", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-dup" });
    dedupMock.findRecentDuplicateSms
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "sms-notif-1" });

    const first = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });
    const second = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(first.smsStatus).toBe("sent");
    expect(second.smsStatus).toBe("skipped");
    expect(second.smsNotificationId).toBe("sms-notif-1");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
  });

  it("allows an explicit resend to send a fresh SMS", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    dedupMock.findRecentDuplicateSms.mockResolvedValue({ id: "sms-notif-prior" });
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-resend" });

    const result = await sendOrderSms({
      ...BASE_PARAMS,
      businessPlan: "beta",
      skipDuplicateCheck: true,
    });

    expect(result.smsStatus).toBe("sent");
    expect(dedupMock.findRecentDuplicateSms).not.toHaveBeenCalled();
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
  });
});

describe("sendOrderSms — edge cases", () => {
  beforeEach(() => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
  });

  it("delegates phone validation to the SMS provider layer", async () => {
    smsMock.sendSms.mockResolvedValue({ success: false, error: "Invalid destination number" });

    const result = await sendOrderSms({ ...BASE_PARAMS, customerPhone: "not-a-phone", businessPlan: "beta" });

    expect(smsMock.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "not-a-phone" }),
    );
    expect(result.smsStatus).toBe("failed");
  });

  it("records independent concurrent SMS attempts", async () => {
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-concurrent" });

    const [a, b] = await Promise.all([
      sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" }),
      sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" }),
    ]);

    expect(a.smsStatus).toBe("sent");
    expect(b.smsStatus).toBe("sent");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(2);
    expect(inserted).toHaveLength(2);
  });

  it("a provider timeout (rejected promise) resolves to 'failed', not a thrown error", async () => {
    smsMock.sendSms.mockResolvedValue({ success: false, error: "fetch failed: ETIMEDOUT" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("failed");
    expect(inserted[0].status).toBe("failed");
  });
});
