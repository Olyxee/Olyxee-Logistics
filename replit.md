# Olyxee Logistics

Olyxee Logistics manages cross-border shipments, invoices, customer updates, and public order tracking.

## Run & Operate

- The web artifact serves `/` on port 23915; the API artifact serves `/api` on port 8080. Start both using their Replit workflows.
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080; workflow supplies `PORT`)
- `pnpm --filter @workspace/olyxee-admin run dev` — run the web app (port 23915; workflow supplies `PORT`)
- `pnpm --filter @workspace/api-server run test` and `pnpm --filter @workspace/olyxee-admin run test` — app tests
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Replit development Postgres connection; `SESSION_SECRET` signs sessions. For an existing external database, `APP_DATABASE_URL` takes precedence; never silently replace its data with the development database.

## Stack

- pnpm workspaces, Node.js 20+, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM API bundle) and Vite (static web app)

## Where things live

- Shared launch/plan config: `lib/plans/src/index.ts` (`@workspace/plans`) — plan catalog, `featureFlags`, launch/trial dates, countdown helper. Single source of truth for pricing UI, badges, and (future) enforcement.
- DB schema (source of truth): `lib/db/src/schema/*.ts` (barrel: `schema/index.ts`). Launch-prep tables: `notification_events`, `notification_deliveries`, `billing_events`, `api_keys`, `call_records`.
- API contracts: `lib/api-spec/openapi.yaml` → `pnpm --filter @workspace/api-spec run codegen`.
- Backend feature foundations: `artifacts/api-server/src/lib/{sms,notifications,branding,paystack,call-centre,plan-enforcement}.ts`; routes `artifacts/api-server/src/routes/{billing,v1}.ts`.
- Launch-prep UI: `artifacts/olyxee-admin/src/pages/{whats-new,coming-soon,upgrade}.tsx`, `src/components/launch-countdown.tsx`, `src/lib/launch.ts` (re-exports `@workspace/plans`).

## Architecture decisions

- Every unfinished capability is gated by `featureFlags` in `@workspace/plans` (all false this release). Modules no-op / return 503 / fall back to defaults while off. See `.agents/memory/launch-prep-foundations.md`.
- Route-level gates are path-scoped (`router.use("/v1", gate)`) — an unscoped gate mounted via `router.use(childRouter)` becomes a catch-all for unmatched routes.
- Paystack billing is env-gated, not gated by the `subscriptionBilling` flag: `sk_test_` key + `ENABLE_TEST_BILLING=1` (test) or `sk_live_` key + `ENABLE_LIVE_BILLING=1` (live). A key alone never activates billing. Webhook verifies HMAC over the raw body; activation validates paid amount vs plan and is idempotent via `billing_events.dedupe_key`. The Upgrade page checkout buttons additionally stay hidden for normal users until `featureFlags.subscriptionBilling` flips at launch.
- Shared notification service records to new tables additively/best-effort; the legacy `email_notifications` flow is untouched.

## Product

Olyxee Logistics is a cross-border order-tracking and customer-notification system: create orders, generate invoices, confirm payment manually, advance shipment status, and email customers branded updates. Billing gateways, SMS, a public API, and an automated call centre remain scaffolded or disabled.

## User preferences

- Replit development uses artifact path routing: `/api` goes to Express and other paths go to Vite. Vercel builds the same apps as a Vite static site plus an Express serverless function; configure secrets and database URLs separately in each platform.
- No SMSPortal sender ID: SMS goes out from a shared SMSPortal number for all tenants. When the SMS channel is enabled, each message body must lead with the business's name (multi-tenant branding lives in the message text, not the sender).

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
