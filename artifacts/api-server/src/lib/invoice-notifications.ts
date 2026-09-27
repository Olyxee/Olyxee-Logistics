import { db, smsNotificationsTable } from "@workspace/db";
import { generateId } from "./id";
import { sendSms, isSmsConfigured } from "./sms";
import { buildInvoiceSmsBody } from "./sms-templates";
import { getMonthlySmsUsage } from "./sms-usage";
import { findRecentDuplicateSms } from "./sms-dedup";
import { getPlan, type PlanId } from "@workspace/plans";
import { logger } from "./logger";

export type SendInvoiceSmsResult = {
  smsStatus: "sent" | "failed" | "skipped" | "limit_reached";
  smsNotificationId: string | undefined;
};

// Confirms an invoice was sent, by SMS, alongside the emailed PDF. Shares the
// order-linked sms_notifications table and monthly usage counter with order
// status SMS - both draw from the same per-business monthly allowance.
export async function sendInvoiceSms(params: {
  orderId: string;
  customerPhone: string | undefined;
  businessName: string;
  invoiceNumber: string;
  total: number;
  currency: string;
  trackingId?: string | null;
  businessPlan: PlanId;
  businessId: string;
  // An explicit invoice resend deliberately wants a fresh send even if an
  // identical message already went out - only the first-send path (which a
  // retried request could trigger twice) dedupes by default. Matches
  // sendOrderSms's skipDuplicateCheck.
  skipDuplicateCheck?: boolean;
}): Promise<SendInvoiceSmsResult> {
  const {
    orderId,
    customerPhone,
    businessName,
    invoiceNumber,
    total,
    currency,
    trackingId,
    businessPlan,
    businessId,
    skipDuplicateCheck,
  } = params;

  if (!customerPhone || !isSmsConfigured()) {
    return { smsStatus: "skipped", smsNotificationId: undefined };
  }

  const smsBody = buildInvoiceSmsBody({ businessName, invoiceNumber, total, currency, trackingId });

  if (!skipDuplicateCheck) {
    const duplicate = await findRecentDuplicateSms(orderId, smsBody);
    if (duplicate) {
      logger.info(
        { orderId, invoiceNumber, smsNotificationId: duplicate.id },
        "Skipping invoice SMS - identical message already sent recently for this order",
      );
      return { smsStatus: "skipped", smsNotificationId: duplicate.id };
    }
  }

  const smsLimit = getPlan(businessPlan).smsLimit ?? null;
  const smsUsage = await getMonthlySmsUsage(businessId);

  if (smsLimit !== null && smsUsage >= smsLimit) {
    const notif = await db
      .insert(smsNotificationsTable)
      .values({
        id: generateId(),
        orderId,
        customerPhone,
        body: smsBody,
        status: "limit_reached",
        providerMessageId: null,
      })
      .returning();
    return { smsStatus: "limit_reached", smsNotificationId: notif[0]?.id };
  }

  const result = await sendSms({ to: customerPhone, body: smsBody });
  const smsStatus: SendInvoiceSmsResult["smsStatus"] = result.success ? "sent" : "failed";
  const providerMessageId = result.success ? (result.providerMessageId ?? null) : null;

  const notif = await db
    .insert(smsNotificationsTable)
    .values({
      id: generateId(),
      orderId,
      customerPhone,
      body: smsBody,
      status: smsStatus,
      providerMessageId,
    })
    .returning();

  return { smsStatus, smsNotificationId: notif[0]?.id };
}
