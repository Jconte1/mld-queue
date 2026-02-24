# SpecBooks Integration Gateway + Worker MVP

This repo now contains a focused MVP with:

- `gateway/` Next.js App Router API gateway (Vercel-ready)
- `worker/` Node.js TypeScript queue worker (Azure Container Apps-ready)
- `prisma/schema.prisma` shared database schema

Partner-facing contract:

- `docs/specbooks-api-contract.md`

## Scope

Supported command types only:

1. `GET_CUSTOMER`
2. `GET_OPPORTUNITY`
3. `CREATE_OPPORTUNITY`
4. `UPDATE_OPPORTUNITY`

All routes are async and return a `jobId`.

## API Endpoints

- `GET /api/specbooks/customers/:customerId`
- `GET /api/specbooks/opportunities/:opportunityId`
- `POST /api/specbooks/opportunities`
- `PATCH /api/specbooks/opportunities/:opportunityId`
- `GET /api/specbooks/jobs/:jobId`

Required auth header on every endpoint:

- `X-SPECBOOKS-API-KEY: <SPECBOOKS_API_KEY>`

For `POST /api/specbooks/opportunities`:

- `Idempotency-Key` is required

For `PATCH /api/specbooks/opportunities/:opportunityId`:

- updates are coalesced per opportunity (`latest update wins`)
- debounce window is configurable via `UPDATE_COALESCE_WINDOW_MS` (worker env, default `5000`)

## Database Setup (Prisma + Postgres)

1. Create a Postgres database.
2. Set `DATABASE_URL` in both `gateway/.env.local` and `worker/.env`.
3. Install deps and generate Prisma client in each app:
   - `cd gateway && npm install && npm run prisma:generate`
   - `cd worker && npm install && npm run prisma:generate`
4. Run migration from either app folder:
   - `npm run prisma:migrate`

The schema is shared at `prisma/schema.prisma`.

## Local Development

### Gateway

1. `cd gateway`
2. `cp .env.example .env.local` (or create manually on Windows)
3. Fill values.
4. `npm install`
5. `npm run prisma:generate`
6. `npm run dev`

### Worker

1. `cd worker`
2. `cp .env.example .env` (or create manually on Windows)
3. Fill values.
4. `npm install`
5. `npm run prisma:generate`
6. `npm run dev`

The worker exposes `GET /healthz` on `PORT` (default `8080`).

## Environment Variables

### Gateway

- `SPECBOOKS_API_KEY`
- `AZURE_SERVICEBUS_CONNECTION_STRING`
- `SPECBOOKS_QUEUE_NAME`
- `DATABASE_URL`
- `RATE_LIMIT_WINDOW_SECONDS`
- `RATE_LIMIT_GET_CUSTOMER`
- `RATE_LIMIT_GET_OPPORTUNITY`
- `RATE_LIMIT_CREATE_OPPORTUNITY`
- `RATE_LIMIT_UPDATE_OPPORTUNITY`
- `MAX_REQUEST_BYTES`
- `MAX_STRING_LENGTH`

### Worker

- `AZURE_SERVICEBUS_CONNECTION_STRING`
- `SPECBOOKS_QUEUE_NAME`
- `DATABASE_URL`
- `ACUMATICA_BASE_URL`
- `ACUMATICA_CLIENT_ID`
- `ACUMATICA_CLIENT_SECRET`
- `ACUMATICA_USERNAME`
- `ACUMATICA_PASSWORD`
- `ACUMATICA_ENDPOINT_NAME`
- `ACUMATICA_ENDPOINT_VERSION`
- `ACUMATICA_CUSTOMER_ENTITY`
- `ACUMATICA_OPPORTUNITY_ENTITY`
- `VENDOR_MAX_CONCURRENCY` (default `8`)
- `VENDOR_MAX_RPM` (default `90`)
- `GLOBAL_MAX_CONCURRENCY` (default `12`)
- `GLOBAL_MAX_RPM` (default `200`)
- `UPDATE_COALESCE_WINDOW_MS` (default `5000`)
- `PORT` (default `8080`)

## Azure Deployment Outline

### Azure Service Bus

1. Create a namespace and queue.
2. Set queue name to `SPECBOOKS_QUEUE_NAME`.
3. Configure queue `maxDeliveryCount` (for retries and DLQ behavior).

### Gateway on Vercel

1. Deploy `gateway/` as a Vercel project.
2. Set all gateway env vars in Vercel.
3. Ensure Vercel has outbound access to Service Bus and Postgres.

### Worker on Azure Container Apps

1. Build image from `worker/Dockerfile`.
2. Push image to ACR.
3. Deploy one replica in ACA for this MVP.
4. Set worker env vars in ACA.
5. Configure liveness/readiness probe to `/healthz`.

## Notes / TODOs

- Acumatica endpoint paths are centralized in `worker/src/lib/acumaticaClient.ts` via env config.
- Opportunity create/update payload allowlist is strict and intentionally small for MVP; expand once your final field contract is confirmed.
- Current throttling is process-local and assumes one worker replica for strict cap enforcement in MVP.
- API deprecation/migration date for direct Acumatica access must be finalized in `docs/specbooks-api-contract.md`.
