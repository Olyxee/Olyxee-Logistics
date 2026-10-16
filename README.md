# Olyxee Logistics

Olyxee Logistics is an operations console for managing cross-border air and sea shipments after a customer has accepted a quote.

Quotes are prepared and accepted outside this application, normally by email. The platform begins with order creation: an administrator creates the shipment, generates its invoice, confirms payment manually after receiving confirmation by phone or another offline channel, and progresses the shipment through its operational statuses.

There is no payment-gateway integration in the current workflow, and the warehouse module is intentionally out of scope.

## Current workflow

1. The customer receives and accepts a quote outside Olyxee Logistics.
2. An administrator creates or selects the customer.
3. The administrator creates an AIR or SEA cross-border order.
4. The order records its route, cargo, service, weight, dimensions, reference, and estimated delivery date.
5. The administrator generates one invoice linked directly to the order.
6. The invoice moves from `draft` to `sent`.
7. After offline payment confirmation, the administrator marks the invoice as `paid`.
8. The administrator adds the supplier or courier tracking number when it becomes available.
9. The administrator progresses the shipment through the appropriate air or sea status flow.

Status updates are stored in the tracking timeline. Customer notification emails require Resend to be configured; shipment updates still persist when email delivery is unavailable.

## What the monorepo contains

| Path | Purpose |
| --- | --- |
| `artifacts/olyxee-admin` | React, Vite, Tailwind, and TanStack Query administration interface |
| `artifacts/api-server` | Express API, authentication, order workflow, invoices, notifications, and public tracking |
| `lib/db` | Drizzle ORM PostgreSQL schema and SQL migrations |
| `lib/api-spec` | OpenAPI source and client-generation configuration |
| `lib/api-client-react` | Generated React API client |
| `lib/api-zod` | Generated request and response validation schemas |
| `lib/order-statuses` | Air, sea, and legacy status definitions and transition logic |
| `lib/plans` | Plan and feature-limit definitions |
| `artifacts/mockup-sandbox` | Standalone UI mockup/build artifact |

The admin UI calls `/api/*`. During development, Vite proxies those requests to the API at `http://localhost:8080`. The API validates requests with generated Zod schemas and persists tenant-scoped records in PostgreSQL through Drizzle ORM.

## Requirements

- Node.js 22 or later
- pnpm 10
- PostgreSQL 16 or a compatible hosted PostgreSQL service
- Docker Desktop is optional but convenient for local PostgreSQL

## Local setup

Install dependencies:

```powershell
pnpm install
```

Create an ignored `.env` file from `.env.example` and configure at least:

```dotenv
DATABASE_URL=postgres://olyxee:olyxee_local@localhost:54329/olyxee_logistics
SESSION_SECRET=replace-with-a-long-local-development-secret
PORT=8080
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5001
```

Never place real production credentials in repository files.

### Optional local PostgreSQL with Docker

```powershell
docker run -d --name olyxee-logistics-db `
  -e POSTGRES_USER=olyxee `
  -e POSTGRES_PASSWORD=olyxee_local `
  -e POSTGRES_DB=olyxee_logistics `
  -p 54329:5432 `
  -v olyxee-logistics-pgdata:/var/lib/postgresql/data `
  postgres:16-alpine
```

Apply the current schema to a new local development database:

```powershell
$env:DATABASE_URL='postgres://olyxee:olyxee_local@localhost:54329/olyxee_logistics'
pnpm --filter @workspace/db run push
```

For controlled production releases, apply the checked-in migrations in order instead of relying on `drizzle push`:

1. `lib/db/drizzle/0000_init_schema.sql`
2. `lib/db/drizzle/0001_complete_production_schema.sql`

## Run the application

Start the API:

```powershell
pnpm --filter @workspace/api-server run dev
```

In another terminal, start the admin UI on its default port:

```powershell
pnpm --filter @workspace/olyxee-admin run dev
```

To use port `5001`:

```powershell
$env:PORT='5001'
pnpm --filter @workspace/olyxee-admin run dev
```

Open `http://localhost:3000/orders` or `http://localhost:5001/orders`, depending on the selected port.

In non-production mode, the local demo login is:

```text
Email: demo
Password: demo
```

## Health checks

- `GET /api/healthz` checks that the API process is alive.
- `GET /api/readyz` checks that the API can reach PostgreSQL and is ready to receive traffic.

Production infrastructure should use `/api/readyz` for readiness and `/api/healthz` for liveness.

## Production SMS deployment

SMS lifecycle notification configuration, rollout checks, and live-send
verification are documented in [the SMS production deployment runbook](./docs/sms-production-deployment.md).

## Tests and verification

Run all available tests:

```powershell
pnpm -r --if-present test
```

Run the complete typecheck and production build:

```powershell
pnpm run build
```

Run the production dependency security audit:

```powershell
pnpm audit --prod --audit-level high
```

Regenerate typed clients after changing `lib/api-spec/openapi.yaml`:

```powershell
pnpm --filter @workspace/api-spec run codegen
```

The latest production-readiness run passed 93 automated tests, all workspace typechecks, all production builds, clean migration application, production-mode liveness/readiness checks, and the full customer → order → invoice → manual payment → shipment-status browser flow.

## Production environment

Required:

- `DATABASE_URL`
- `SESSION_SECRET` — at least 16 characters and generated securely
- `PORT`
- `ALLOWED_ORIGINS`

Required for the intended hosted experience:

- `PUBLIC_APP_URL`
- `PUBLIC_TRACKING_URL`
- `RESEND_API_KEY`
- `EMAIL_FROM_ADDRESS`

Optional integrations remain disabled unless their matching credentials and feature flags are configured. See `.env.example` for SMS, billing, and call-centre settings.

## Production release checklist

- Rotate any credential that has ever appeared in Git or another plaintext file, then remove it from repository history.
- Store secrets only in the deployment platform's encrypted environment-variable manager.
- Apply and verify every SQL migration against a staging copy of the production database.
- Confirm `/api/healthz` and `/api/readyz` both return HTTP 200.
- Verify allowed origins, secure session cookies, and the public application/tracking URLs.
- Verify real status-email delivery from the configured sender domain.
- Run all tests, the full build, dependency audit, and an end-to-end staging flow.
- Confirm database backups and a tested rollback procedure before migration.
- Do not enable live billing unless the business explicitly decides to restore a payment-gateway workflow.

## Security notes

- All operational queries are scoped to the authenticated business.
- Order creation verifies that the customer belongs to the same business.
- Public tracking responses exclude customer, invoice, supplier, business, and staff identifiers.
- Supplier tracking numbers are unique per business.
- An order can have only one invoice.
- Payment confirmation is an explicit administrative action and does not imply that funds were processed by this application.
