import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendSms = vi.fn();
const mockIsSmsConfigured = vi.fn();
vi.mock("../lib/sms", () => ({
  sendSms: (...args: unknown[]) => mockSendSms(...args),
  isSmsConfigured: (...args: unknown[]) => mockIsSmsConfigured(...args),
}));

vi.mock("../lib/sms-templates", () => ({
  buildSmsBody: vi.fn(() => "Acme: ACM-1 | Delivered | https://track.example.com"),
}));

const mockGetMonthlySmsUsage = vi.fn();
vi.mock("../lib/sms-usage", () => ({
  getMonthlySmsUsage: (...args: unknown[]) => mockGetMonthlySmsUsage(...args),
}));

const mockFindRecentDuplicateSms = vi.fn();
vi.mock("../lib/sms-dedup", () => ({
  findRecentDuplicateSms: (...args: unknown[]) => mockFindRecentDuplicateSms(...args),
}));

vi.mock("@workspace/plans", () => ({
  getPlan: vi.fn(() => ({ smsLimit: 100 })),
}));

let idCounter = 0;
vi.mock("../lib/id", () => ({
  generateId: () => `sms-id-${++idCounter}`,
}));

const mockReturning = vi.fn();
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn((..._args: unknown[]) => ({ values: mockValues }));
vi.mock("@workspace/db", () => ({
  db: { insert: (...args: unknown[]) => mockInsert(...args) },
  smsNotificationsTable: { orderId: "orderId" },
}));

import { sendOrderSms } from "../lib/order-notifications";
import { getPlan } from "@workspace/plans";

const BASE_PARAMS = {
  orderId: "order_1",
  customerPhone: "+27821234567",
  businessName: "Acme Freight",
  trackingId: "ACM-1",
  status: "Delivered",
  statusMessage: null,
  trackingLink: "https://track.example.com",
  businessPlan: "free" as const,
  businessId: "biz_1",
};

describe("sendOrderSms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    mockIsSmsConfigured.mockReturnValue(true);
    mockFindRecentDuplicateSms.mockResolvedValue(null);
    mockGetMonthlySmsUsage.mockResolvedValue(0);
    mockReturning.mockResolvedValue([{ id: "sms-id-1" }]);
    (getPlan as ReturnType<typeof vi.fn>).mockReturnValue({ smsLimit: 100 });
  });

  it("skips when there is no customer phone number", async () => {
    const result = await sendOrderSms({ ...BASE_PARAMS, customerPhone: undefined });

    expect(result).toEqual({
      smsStatus: "skipped",
      smsNotificationId: undefined,
      smsUsage: undefined,
      smsLimit: undefined,
    });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("skips when SMS is not configured (flag off or no credentials)", async () => {
    mockIsSmsConfigured.mockReturnValue(false);

    const result = await sendOrderSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("skipped");
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("sends and records a successful delivery", async () => {
    mockSendSms.mockResolvedValue({ success: true, providerMessageId: "msg_1" });

    const result = await sendOrderSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("sent");
    expect(result.smsNotificationId).toBe("sms-id-1");
    expect(result.smsUsage).toBe(1);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", providerMessageId: "msg_1", orderId: "order_1" }),
    );
  });

  it("records a failed delivery without throwing", async () => {
    mockSendSms.mockResolvedValue({ success: false, error: "SMSPortal send failed (500)" });

    const result = await sendOrderSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("failed");
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", providerMessageId: null }),
    );
  });

  it("stops at the monthly plan limit without calling the provider", async () => {
    (getPlan as ReturnType<typeof vi.fn>).mockReturnValue({ smsLimit: 5 });
    mockGetMonthlySmsUsage.mockResolvedValue(5);

    const result = await sendOrderSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("limit_reached");
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ status: "limit_reached" }));
  });

  it("treats a null smsLimit as unlimited", async () => {
    (getPlan as ReturnType<typeof vi.fn>).mockReturnValue({ smsLimit: null });
    mockGetMonthlySmsUsage.mockResolvedValue(999999);
    mockSendSms.mockResolvedValue({ success: true, providerMessageId: "msg_x" });

    const result = await sendOrderSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("sent");
  });

  it("skips a retried send when an identical message was already sent recently", async () => {
    mockFindRecentDuplicateSms.mockResolvedValue({ id: "sms-id-prior" });

    const result = await sendOrderSms(BASE_PARAMS);

    expect(result).toEqual({
      smsStatus: "skipped",
      smsNotificationId: "sms-id-prior",
      smsUsage: undefined,
      smsLimit: undefined,
    });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("bypasses the duplicate check for an explicit resend", async () => {
    mockFindRecentDuplicateSms.mockResolvedValue({ id: "sms-id-prior" });
    mockSendSms.mockResolvedValue({ success: true, providerMessageId: "msg_2" });

    const result = await sendOrderSms({ ...BASE_PARAMS, skipDuplicateCheck: true });

    expect(mockFindRecentDuplicateSms).not.toHaveBeenCalled();
    expect(result.smsStatus).toBe("sent");
    expect(mockSendSms).toHaveBeenCalledTimes(1);
  });
});
