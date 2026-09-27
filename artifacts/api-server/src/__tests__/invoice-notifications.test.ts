import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendSms = vi.fn();
const mockIsSmsConfigured = vi.fn();
vi.mock("../lib/sms", () => ({
  sendSms: (...args: unknown[]) => mockSendSms(...args),
  isSmsConfigured: (...args: unknown[]) => mockIsSmsConfigured(...args),
}));

vi.mock("../lib/sms-templates", () => ({
  buildInvoiceSmsBody: vi.fn(() => "Acme: Invoice INV-1 | Amount due: ZAR 100.00"),
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

import { sendInvoiceSms } from "../lib/invoice-notifications";
import { getPlan } from "@workspace/plans";

const BASE_PARAMS = {
  orderId: "order_1",
  customerPhone: "+27821234567",
  businessName: "Acme Freight",
  invoiceNumber: "INV-1",
  total: 100,
  currency: "ZAR",
  trackingId: "ACM-1",
  businessPlan: "free" as const,
  businessId: "biz_1",
};

describe("sendInvoiceSms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    mockIsSmsConfigured.mockReturnValue(true);
    mockFindRecentDuplicateSms.mockResolvedValue(null);
    mockGetMonthlySmsUsage.mockResolvedValue(0);
    mockReturning.mockResolvedValue([{ id: "sms-id-1" }]);
    (getPlan as ReturnType<typeof vi.fn>).mockReturnValue({ smsLimit: 100 });
  });

  it("skips when the customer has no phone number", async () => {
    const result = await sendInvoiceSms({ ...BASE_PARAMS, customerPhone: undefined });

    expect(result).toEqual({ smsStatus: "skipped", smsNotificationId: undefined });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("skips when SMS is not configured", async () => {
    mockIsSmsConfigured.mockReturnValue(false);

    const result = await sendInvoiceSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("skipped");
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("sends and records a successful invoice SMS", async () => {
    mockSendSms.mockResolvedValue({ success: true, providerMessageId: "msg_1" });

    const result = await sendInvoiceSms(BASE_PARAMS);

    expect(result).toEqual({ smsStatus: "sent", smsNotificationId: "sms-id-1" });
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", orderId: "order_1", providerMessageId: "msg_1" }),
    );
  });

  it("records a failed provider send without throwing", async () => {
    mockSendSms.mockResolvedValue({ success: false, error: "provider down" });

    const result = await sendInvoiceSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("failed");
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", providerMessageId: null }),
    );
  });

  it("stops at the monthly plan limit without calling the provider", async () => {
    (getPlan as ReturnType<typeof vi.fn>).mockReturnValue({ smsLimit: 3 });
    mockGetMonthlySmsUsage.mockResolvedValue(3);

    const result = await sendInvoiceSms(BASE_PARAMS);

    expect(result.smsStatus).toBe("limit_reached");
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("skips a duplicate invoice SMS sent moments earlier", async () => {
    mockFindRecentDuplicateSms.mockResolvedValue({ id: "sms-id-prior" });

    const result = await sendInvoiceSms(BASE_PARAMS);

    expect(result).toEqual({ smsStatus: "skipped", smsNotificationId: "sms-id-prior" });
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("bypasses the duplicate check for an explicit invoice resend", async () => {
    mockFindRecentDuplicateSms.mockResolvedValue({ id: "sms-id-prior" });
    mockSendSms.mockResolvedValue({ success: true, providerMessageId: "msg_2" });

    const result = await sendInvoiceSms({ ...BASE_PARAMS, skipDuplicateCheck: true });

    expect(mockFindRecentDuplicateSms).not.toHaveBeenCalled();
    expect(result.smsStatus).toBe("sent");
    expect(mockSendSms).toHaveBeenCalledTimes(1);
  });
});
