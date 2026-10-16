# SMS production deployment runbook

This runbook covers deploying SMSPortal-backed lifecycle notifications for Olyxee Logistics. SMS is enabled for all plans without a monthly plan quota. A message is sent only when the customer has a valid phone number and SMSPortal is configured in the API environment.

## Before deploying

- Confirm the SMSPortal account is approved for production sending and has sufficient credit.
- Create or rotate the SMSPortal REST API client ID and API secret. Store them only in the deployment platform's encrypted environment-variable store. Do not commit them, paste them into tickets, or print them in build logs.
- Confirm whether the account requires an approved sender ID. If it does, configure the approved value; otherwise leave `SMS_SENDER_ID` unset.
- Arrange a controlled production smoke test to a phone number owned by the team. Live sends are chargeable; there is no Settings test-SMS button and this integration does not set SMSPortal's test mode.
- Ensure customer notification consent and the business's applicable SMS/privacy obligations are satisfied.

## Configure Vercel

The repository's `vercel.json` builds the API bundle and admin application together. In the Vercel project, open **Settings → Environment Variables** and add these variables for the **Production** environment:

| Variable | Required | Value |
| --- | --- | --- |
| `SMS_PROVIDER` | Yes | `smsportal` |
| `SMSPORTAL_CLIENT_ID` | Yes | SMSPortal REST API client ID |
| `SMSPORTAL_API_SECRET` | Yes | SMSPortal REST API secret |
| `SMS_SENDER_ID` | Only if required | SMSPortal-approved sender ID; omit if not required |

`SMS_PROVIDER` defaults to `smsportal`, but set it explicitly so a typo or deployment configuration drift is visible. Do not configure `SMS_PROVIDER=noop` in Production: that provider only logs a simulated send and sends no handset message. Keep SMSPortal credentials out of Preview and Development unless a deliberate, controlled live-send test is planned there.

The API already requires `DATABASE_URL` and `SESSION_SECRET` in Production. Configure these through the same secret store if they are not already present. `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` are needed for invoice email, but email delivery is independent of the SMS attempt.

## Deploy the branch

1. Run the focused SMS tests and API typecheck from the repository root:

   ```powershell
   pnpm --filter @workspace/api-server test -- src/__tests__/sms.test.ts src/__tests__/sms-provider.test.ts src/__tests__/order-sms-notifications.test.ts src/__tests__/order-notifications.test.ts src/__tests__/invoice-notifications.test.ts src/__tests__/orders-transport.test.ts
   pnpm --filter @workspace/plans test -- src/index.test.ts
   pnpm --filter @workspace/api-server typecheck
   ```

2. Open a pull request for this branch and wait for repository-required checks and the Vercel Preview build to pass.
3. Review the Production environment variables in Vercel without displaying or copying their secret values.
4. Merge through the repository's normal release process and let Vercel deploy the production branch. The feature flag and plan catalog are compiled into the deployment, so changing these code settings requires a new build/deploy.
5. No database migration is introduced by the lifecycle SMS changes. The existing SMS notification table is used to record send attempts and provider acceptance.
6. Confirm Vercel reports a successful deployment and check `GET /api/healthz` for liveness and `GET /api/readyz` for API/database readiness.

Do not expose credentials in the deployment log or terminal output. If a credential was previously shared outside the secret store, revoke it in SMSPortal and create a replacement before deployment.

## Verify one live send

1. Select a production test business and a test customer whose saved phone is a valid mobile number. For South African mobiles, local `0xx…` inputs are normalized to `+27…`; international numbers must be valid E.164.
2. Use an order with a phone you control. Send only the minimum messages needed to validate the flow; a PREPAID order can attempt both an order-created SMS and an auto-invoice SMS.
3. Trigger the intended lifecycle event in the normal application workflow (order creation, invoice send, payment confirmation, or shipment status update). Do not use a Settings test action; it has been removed.
4. Check the API response and server logs for the SMS status and the masked recipient. A successful status / provider message ID means SMSPortal accepted the request, not that the handset received it.
5. Confirm actual receipt on the controlled handset and, if needed, check delivery status in SMSPortal. This application does not currently process provider delivery receipts.
6. Check notification history for the recorded send attempt and ensure no duplicate messages were produced.

SMS is best-effort: a provider failure does not undo order, invoice, payment, or shipment updates. Invoice SMS is attempted independently of invoice email, so an email-domain failure does not prevent the SMS attempt. Order notifications still depend on customer notification being enabled for that event and on there being a valid saved customer phone.

## Troubleshooting and rollback

| Symptom | Check |
| --- | --- |
| SMS is skipped and no provider call is made | Confirm the deployed build includes `smsNotifications: true`, `SMS_PROVIDER=smsportal`, and that the customer has a phone number. Check for duplicate suppression on repeated status requests. |
| `SMS provider not configured` | Confirm both SMSPortal credentials exist in the API's **Production** environment and redeploy/restart the API after changing environment variables. Never print the values. |
| `SMSPortal authentication failed (401)` | **Observed finding:** the SMS integration works in development with the account owner's own SMSPortal API key pair. The different key pair shown in the screenshots is rejected with HTTP 401 during SMSPortal authentication, before a message request is made. This isolates the reported failure to that credential pair; the 401 is not caused by the recipient number, sender ID, message content, or SMS credits. |
| SMSPortal authentication/send failure other than 401 | Check SMSPortal production access, account status, available credit, and any provider-side restrictions. Logs include provider status and a masked phone number, not the complete recipient. |
| `limit_reached` | Verify the deployed plan catalog has no SMS quota (`smsLimit: null`) for the business plan and that the latest API bundle is deployed. |
| Provider accepts the request but no handset message arrives | Check SMSPortal delivery status, account credit, destination validity, network/provider restrictions, and sender-ID approval. API acceptance alone is not delivery proof. |
| A test logs `[sms:noop]` | `SMS_PROVIDER=noop` is active or the provider value is invalid. Set it to `smsportal` in Production, configure credentials, and redeploy. |

For an immediate stop to external messages while preserving other workflows, set Production `SMS_PROVIDER=noop` and redeploy/restart the API; messages will be simulated and not delivered. The current no-op adapter returns success to the caller, so records and API responses can say `sent`; use its explicit simulation log to distinguish that from a provider-accepted message. To fully disable the channel, revert `featureFlags.smsNotifications` to `false` and deploy that change.
