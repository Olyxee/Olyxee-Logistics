# Logistics SMS phone handling: investigation and test guide

## What the code currently does

1. The order detail page submits an order ID and status fields; it does not submit a destination phone number. `useUpdateOrderStatus` in `artifacts/olyxee-admin/src/hooks/use-supabase-queries.ts` sends `POST /api/orders/:orderId/status`. The form handler is `handleStatusUpdate` in `artifacts/olyxee-admin/src/pages/order-detail.tsx`.
2. The API mounts the orders router under `/api`. The authenticated route is `POST /orders/:orderId/status` in `artifacts/api-server/src/routes/orders.ts`; its request schema accepts `status`, optional `message`, `location`, `exceptionType`, `notifyCustomer`, and `skipReason`.
3. The route loads the order by both order ID and authenticated business ID, then loads its customer by `order.customerId` and the same business ID. The database relationship is `orders.customerId` to `customers.id`; the stored contact field is nullable `customers.phone` (not `phoneNumber` or `mobile`).
4. After the order/tracking update commits, the route calls `sendOrderSms` with `customer.phone`. SMS is best-effort and does not roll back or fail the status update.
5. `sendSms` validates the recipient and converts accepted inputs to E.164 before calling the provider. The SMSPortal JSON field is `messages[0].destination`; message content is `messages[0].content`.
6. SMSPortal uses `GET https://rest.smsportal.com/Authentication` and `POST https://rest.smsportal.com/BulkMessages`. A successful HTTP send response means the provider accepted the request; this application does not receive handset-delivery confirmation.

## Findings and change

- The frontend/backend field mapping is consistent: the customer editor writes `phone`, and the order status path reads `customer.phone`. The phone is correctly associated using the order's customer ID and business ID.
- The released `featureFlags.smsNotifications` in `lib/plans/src/index.ts` is enabled. SMS is available to every plan without a monthly plan quota; SMSPortal credentials are still required for live sends.
- With the feature enabled, old normalization only removed formatting and passed `0821234567` through unchanged. SMSPortal documents E.164 for international sends; sending a local-format number is therefore not a safe provider destination. The old validator also accepted short arbitrary digit strings.
- Normalization now converts local `06`-`08` South African mobile numbers and `27`-prefixed South African mobile numbers to `+27…`, accepts valid E.164 international numbers, and rejects malformed, incomplete, whitespace-only, or unsupported local values before making a provider request.
- Provider diagnostics now log only a recipient mask (last four digits), provider status/message ID, and non-sensitive message length. Provider response bodies and complete phone numbers are no longer logged. Missing phone numbers produce an order-scoped warning when the SMS channel is configured.

SMSPortal documentation:

- [REST API best practices](https://docs.smsportal.com/docs/rest-best-practices.md) states that international phone numbers must use E.164.
- [BulkMessages API reference](https://docs.smsportal.com/reference/bulkmessages) documents the API endpoint and `testMode` behavior.
- [REST quick start](https://docs.smsportal.com/docs/quickstart.md) recommends using test mode when validating API requests.

## Automated checks

The focused API tests are:

```powershell
pnpm --filter @workspace/api-server test -- src/__tests__/sms.test.ts src/__tests__/sms-provider.test.ts src/__tests__/order-sms-notifications.test.ts src/__tests__/order-notifications.test.ts src/__tests__/invoice-notifications.test.ts src/__tests__/orders-transport.test.ts
pnpm --filter @workspace/plans test -- src/index.test.ts
pnpm --filter @workspace/api-server typecheck
```

Provider tests use a mocked `fetch`; they do not contact SMSPortal or send messages. They verify normalized `destination` values, malformed-recipient rejection, provider errors, and redacted logs.

## Starting the application locally

Prerequisites: Node.js, pnpm, dependencies installed from the checked-in lockfile, a local PostgreSQL database, and a root `.env` containing at least `DATABASE_URL`. The API requires `PORT`; production mode additionally requires `SESSION_SECRET`.

In PowerShell window 1, from the repository root:

```powershell
$env:PORT = "8080"
pnpm --filter @workspace/api-server dev
```

In PowerShell window 2, from the repository root:

```powershell
pnpm --filter @workspace/olyxee-admin dev
```

Open the Vite URL printed in window 2 (normally `http://localhost:3000`). The frontend proxies `/api` to `http://localhost:8080`. Sign in with a local test account and use a test business/order/customer. Do not use a production account or customer.

For a real lifecycle test, configure SMSPortal REST credentials in `.env`, set `SMS_PROVIDER=smsportal`, restart the API, and use a test order with a phone you control. Real messages may incur charges. For a no-network smoke test, set `SMS_PROVIDER=noop`; automated mocked-provider tests verify request payloads and errors.

PREPAID order creation immediately creates an invoice and attempts to send it. The same request now attempts the invoice SMS independently of email delivery, so an unverified Resend domain does not block the SMS. It returns `invoiceSmsStatus` (`sent`, `failed`, `skipped`, or `limit_reached`) alongside `invoiceEmailStatus`. POSTPAID orders have no invoice at creation, so invoice SMS is sent later when their invoice is sent.

## Manual test cases

For every test, use an isolated local database and authorized test customer/order. Capture the order ID, status before/after, API status/response with customer values redacted, relevant application log lines with only the masked recipient, and notification history. Never capture credentials, full phone numbers, or message bodies containing customer data.

### Test 1: Successful order status update

- **Preconditions:** Local app is running; a test business is selected; a test order can advance to a valid next status; its customer has a valid phone; for prepaid orders, payment is confirmed. If testing without contacting SMSPortal, use the no-op setup above.
- **Actions:** Sign in; open the test order; choose the next allowed status; leave “notify customer” enabled; submit “Update status.”
- **Expected:** `POST /api/orders/{orderId}/status` succeeds; the order status and tracking event update; the server resolves the customer through `order.customerId` and reads `customers.phone`; `sendSms` passes an E.164 `to` value to the provider adapter. In no-op mode, logs show the simulated send with a masked recipient. Automated mocked-provider tests assert the exact `destination`.
- **Failure indicators:** 4xx/5xx response; unchanged order status; invalid-recipient result; SMSPortal auth/send error. A UI success toast alone is not evidence of SMS delivery.
- **Evidence:** Redacted network request/response, status history, test result output, and masked application log.

### Test 2: Local South African number

- **Preconditions:** Test customer's stored `phone` is `0821234567`; test order is eligible for a status advance.
- **Actions:** On the order detail page, choose **Edit customer information**, set **Phone** to `0821234567`, save, then trigger a status update as in Test 1.
- **Expected:** Provider destination is exactly `+27821234567`; the country trunk `0` is removed and `+27` is added once.
- **Failure indicators:** `0821234567`, `+270821234567`, duplicated country code, or a provider request for an invalid number.
- **Evidence:** The passing `sms-provider.test.ts` mocked payload assertion plus the normalized-input case result. The local no-op log exposes only the masked suffix.

### Test 3: International-format South African number

- **Preconditions:** Test customer's stored `phone` is `+27821234567` (repeat with `27821234567` for international digits without plus).
- **Actions:** On the order detail page, choose **Edit customer information**, set **Phone** to the specified value, save, then trigger a status update.
- **Expected:** Both inputs reach the provider adapter as `+27821234567`; `+27` is not duplicated.
- **Failure indicators:** Added `+27` prefix to an already international number, a missing plus in the final E.164 value, or rejection of a valid input.
- **Evidence:** Mocked payload assertion for both input forms; redact the full number from any manually captured diagnostics.

### Test 4: Missing phone number

- **Preconditions:** Test customer's `phone` is null, empty, or whitespace-only.
- **Actions:** On the order detail page, choose **Edit customer information**, clear **Phone**, save, then trigger an otherwise valid status update with customer notification enabled.
- **Expected:** The order update succeeds; no provider request is made; the SMS is skipped; when the SMS channel is enabled, the server logs an order-scoped “customer phone number is missing” warning without logging contact details.
- **Failure indicators:** Provider request, order status rollback, unhandled exception, or a log containing the customer's full phone number.
- **Evidence:** Order status before/after, no-op/provider call count (zero), and redacted warning entry.

### Test 5: Invalid phone number

- **Preconditions:** Test customer's `phone` is set to an invalid/incomplete value such as `082123456` or `123`.
- **Actions:** On the order detail page, choose **Edit customer information**, set **Phone** to an invalid/incomplete value, save, then trigger a valid status update.
- **Expected:** The order status succeeds independently; `sendSms` returns “Invalid destination phone number”; no authentication or BulkMessages request is made for that recipient.
- **Failure indicators:** Any provider request containing the invalid value or an apparently normalized invalid value.
- **Evidence:** Passing validation/provider tests, status history, mocked fetch call count of zero, and redacted logs.

### Test 6: SMSPortal failure

- **Preconditions:** Use the mocked provider suite; do not substitute live credentials. The tests simulate authentication rejection, HTTP 503, and a network error.
- **Actions:** Run `sms-provider.test.ts`; for route-level local smoke, configure the no-op adapter only (it does not simulate provider failure).
- **Expected:** Failure is returned as a controlled SMS failure; the order remains updated; diagnostic logs contain an HTTP status/error and masked recipient but no provider body or secret.
- **Failure indicators:** Unhandled request failure, order rollback, retry loop beyond the existing single 401 re-authentication, or secret/full-number logging.
- **Evidence:** Test results and logger assertions from the mocked tests.

### Test 7: Regression testing

- **Preconditions:** Use a test customer with valid email and phone, plus a status-advanceable test order.
- **Actions:** Submit one status change with notifications enabled; inspect the order and tracking history, email notification history, and SMS status; separately simulate SMS failure using the focused tests.
- **Expected:** Order and tracking status update once; existing email handling remains unchanged; SMS failure is non-fatal and does not duplicate the order update or email; retry protections/tests continue to pass.
- **Failure indicators:** Status rolls back due to SMS failure; duplicate status/tracking/email side effects; customer/email data changes; regressions in the existing order-SMS test suite.
- **Evidence:** Before/after order status, tracking and email notification history with personal data redacted, focused test output.

## Request/response and delivery verification

- In local provider tests, inspect the mocked POST body shape only: `{ "messages": [{ "content": "...", "destination": "+27..." }] }`. Do not print real message content or customer numbers.
- The current integration does not set SMSPortal `testMode`; a successful real test can send to the mobile network and may use credits. Only send to a phone you control.
- A 2xx BulkMessages response/provider message ID means accepted by SMSPortal, not delivered. Confirm delivery only through the provider's delivery-status facility/webhook or an authorized handset test. This application currently does not record provider delivery receipts.

## Configuration and limitations

- Existing provider configuration: `SMSPORTAL_CLIENT_ID`, `SMSPORTAL_API_SECRET`, optional `SMS_SENDER_ID`, and `SMS_PROVIDER` (`smsportal` or `noop`), documented in `.env.example`.
- The global `smsNotifications` feature flag is enabled in the released configuration. Live SMS still requires valid SMSPortal credentials and an approved sender ID if the provider account requires one.
- Automated tests verify phone normalization, configuration gating, and mocked request/error handling.
- SMSPortal acceptance is not handset delivery. Delivery receipt handling is not implemented.
