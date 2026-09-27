import { db, smsNotificationsTable } from "@workspace/db";
import { generateId } from "./id";
import { sendSms, isSmsConfigured } from "./sms";
import { buildSmsBody } from "./sms-templates";
import { getMonthlySmsUsage } from "./sms-usage";
import { findRecentDuplicateSms } from "./sms-dedup";
import { getPlan, type PlanId } from "@workspace/plans";
import { logger } from "./logger";

export type SendOrderSmsResult = {
  smsStatus: "sent" | "failed" | "skipped" | "limit_reached";
  smsNotificationId: string | undefined;
  smsUsage: number | undefined;
  smsLimit: number | null | undefined;
};

export async function sendOrderSms(params: {
  orderId: string;
  customerPhone: string | undefined;
  businessName: string;
  trackingId: string;
  status: string;
  statusMessage: string | null;
  trackingLink: string;
  businessPlan: PlanId;
  businessId: string;
  // The manual "resend" action deliberately wants a fresh send even if an
  // identical message already went out - only the automatic status-change
  // path (which a retried request could trigger twice) dedupes by default.
  skipDuplicateCheck?: boolean;
}): Promise<SendOrderSmsResult> {
  const {
    orderId,
    customerPhone,
    businessName,
    trackingId,
    status,
    statusMessage,
    trackingLink,
    businessPlan,
    businessId,
    skipDuplicateCheck,
  } = params;

  let smsStatus: SendOrderSmsResult["smsStatus"] = "skipped";
  let smsNotificationId: string | undefined;
  let smsUsage: number | undefined;
  let smsLimit: number | null | undefined;

  if (customerPhone && isSmsConfigured()) {
    const smsBody = buildSmsBody({
      businessName,
      trackingId,
      status,
      statusMessage,
      trackingLink,
      customerPhone,
    });

    if (!skipDuplicateCheck) {
      const duplicate = await findRecentDuplicateSms(orderId, smsBody);
      if (duplicate) {
        logger.info(
          { orderId, smsNotificationId: duplicate.id },
          "Skipping SMS send - identical message already sent recently for this order",
        );
        return {
          smsStatus: "skipped",
          smsNotificationId: duplicate.id,
          smsUsage: undefined,
          smsLimit: undefined,
        };
      }
    }

    smsLimit = getPlan(businessPlan).smsLimit ?? null;
    smsUsage = await getMonthlySmsUsage(businessId);

    if (smsLimit !== null && smsUsage >= smsLimit) {
      smsStatus = "limit_reached";
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
      smsNotificationId = notif[0]?.id;
    } else {
      const smsResult = await sendSms({ to: customerPhone, body: smsBody });
      const smsProviderMessageId = smsResult.success ? smsResult.providerMessageId : null;
      smsStatus = smsResult.success ? "sent" : "failed";
      if (smsStatus === "sent") smsUsage = (smsUsage ?? 0) + 1;

      const notif = await db
        .insert(smsNotificationsTable)
        .values({
          id: generateId(),
          orderId,
          customerPhone,
          body: smsBody,
          status: smsStatus,
          providerMessageId: smsProviderMessageId,
        })
        .returning();
      smsNotificationId = notif[0]?.id;
    }
  }

  return { smsStatus, smsNotificationId, smsUsage, smsLimit };
}
