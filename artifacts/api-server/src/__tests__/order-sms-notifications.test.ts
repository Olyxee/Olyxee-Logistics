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

const usageMock = vi.hoisted(() => ({ getMonthlySmsUsage: vi.fn() }));
vi.mock("../lib/sms-usage", () => usageMock);

// lib/order-notifications.ts calls findRecentDuplicateSms (lib/sms-dedup.ts,
// a db.select query) before sending. Mock the dedup module directly rather
// than reimplementing drizzle's query chain here - defaults to "no recent
// duplicate" so existing tests are unaffected; the dedup describe block below
// overrides this per-case to exercise both outcomes.
const dedupMock = vi.hoisted(() => ({ findRecentDuplicateSms: vi.fn() }));
vi.mock("../lib/sms-dedup", () => dedupMock);

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
  // free/pro/business all define smsLimit: 0 in @workspace/plans. Since
  // getMonthlySmsUsage() starts at 0 for a business that has never sent an
  // SMS, `0 >= 0` is true immediately: NO paid plan can ever send its first
  // SMS, even with the feature flag on and valid provider credentials. Only
  // "beta" (smsLimit undefined -> unlimited) can send. This is a real gap
  // worth confirming intentional with the product owner.
  it.each(["free", "pro", "business"] as const)(
    "plan '%s' hits limit_reached on the very first SMS because smsLimit is 0",
    async (plan) => {
      smsMock.isSmsConfigured.mockReturnValue(true);
      usageMock.getMonthlySmsUsage.mockResolvedValue(0);

      const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: plan });

      expect(result.smsStatus).toBe("limit_reached");
      expect(result.smsLimit).toBe(0);
      expect(smsMock.sendSms).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(1);
      expect(inserted[0].status).toBe("limit_reached");
      expect(inserted[0].providerMessageId).toBeNull();
    },
  );

  it("the 'beta' plan has no SMS limit and can send", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(50);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-1" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("sent");
    expect(result.smsLimit).toBeNull();
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
  });
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

// CORRECTED 2026-09-30: this block originally documented duplicate SMS as an
// unfixed gap ("BUG: sends twice, no dedupe"). That was true against an
// earlier snapshot of main; current main includes lib/sms-dedup.ts
// (findRecentDuplicateSms, a 5-minute same-order+same-body+status=sent
// window) wired into sendOrderSms, plus a skipDuplicateCheck escape hatch
// for the explicit resend path. Equivalent, passing coverage for this also
// lives in order-notifications.test.ts ("skips a retried send..." /
// "bypasses the duplicate check...") - kept here too since this file already
// exists, updated to match reality instead of asserting the old bug.
describe("sendOrderSms — duplicate protection (fixed: lib/sms-dedup.ts)", () => {
  it("does NOT send a second SMS when a recent identical send is found", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    dedupMock.findRecentDuplicateSms.mockResolvedValue({ id: "sms-notif-prior" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("skipped");
    expect(result.smsNotificationId).toBe("sms-notif-prior");
    expect(smsMock.sendSms).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0); // no new row written for a deduped send
  });

  it("does send when no recent duplicate is found (normal, non-duplicate case)", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    dedupMock.findRecentDuplicateSms.mockResolvedValue(null);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-first" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("sent");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
  });

  it("the explicit resend path bypasses the duplicate check via skipDuplicateCheck", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    // Even though a matching recent send exists, skipDuplicateCheck must
    // stop findRecentDuplicateSms from being consulted at all.
    dedupMock.findRecentDuplicateSms.mockResolvedValue({ id: "sms-notif-prior" });
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-resend" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta", skipDuplicateCheck: true });

    expect(dedupMock.findRecentDuplicateSms).not.toHaveBeenCalled();
    expect(result.smsStatus).toBe("sent");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
  });
});

describe("sendOrderSms — edge cases", () => {
  beforeEach(() => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
  });

  it("passes an unvalidated/garbage phone number straight through to the provider layer", async () => {
    // order-notifications.ts does no phone-format validation itself; it
    // relies entirely on sms.ts's normaliseNumber(). Confirms the two layers
    // are wired together as expected rather than each silently assuming the
    // other validates.
    smsMock.sendSms.mockResolvedValue({ success: false, error: "Invalid destination number" });

    const result = await sendOrderSms({ ...BASE_PARAMS, customerPhone: "not-a-phone", businessPlan: "beta" });

    expect(smsMock.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "not-a-phone" }),
    );
    expect(result.smsStatus).toBe("failed");
  });

  it("two concurrent triggers for the same order both go through independently (no lock/dedupe)", async () => {
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

// CORRECTED 2026-09-30: invoice SMS is now implemented (lib/invoice-notifications.ts,
// sendInvoiceSms, wired into routes/invoices.ts's POST /invoices/:id/send) with
// its own full test file at src/__tests__/invoice-notifications.test.ts
// (recipient/template/dedup/limit/resend coverage). No placeholder needed here.
