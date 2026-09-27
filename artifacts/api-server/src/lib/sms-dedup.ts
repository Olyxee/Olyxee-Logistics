import { db, smsNotificationsTable } from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";

// A retried request (client resubmit, a double-click, a reconnect-and-retry
// after a timeout) must never fan out a second identical SMS to a customer.
// Rather than adding new columns/queues, treat "the same order already has a
// successfully-sent SMS with this exact body in the last few minutes" as a
// duplicate and skip re-sending it. This is intentionally narrow: a genuinely
// new status/body, or the same body sent again after the window, still sends.
const DEDUPE_WINDOW_MS = 5 * 60_000;

export async function findRecentDuplicateSms(
  orderId: string,
  body: string,
): Promise<{ id: string } | null> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const rows = await db
    .select({ id: smsNotificationsTable.id })
    .from(smsNotificationsTable)
    .where(
      and(
        eq(smsNotificationsTable.orderId, orderId),
        eq(smsNotificationsTable.body, body),
        eq(smsNotificationsTable.status, "sent"),
        gte(smsNotificationsTable.createdAt, since),
      ),
    )
    .orderBy(desc(smsNotificationsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
