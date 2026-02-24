# SpecBooks API Contract (Integration Gateway)

## Overview

SpecBooks must integrate only with this HTTPS Gateway. Direct access to Azure Service Bus and direct access to Acumatica are not allowed.

Migration notice:

- Direct Acumatica access is deprecated effective `TODO: INSERT DATE`.
- After that date, only the Gateway endpoints in this document are supported.

All operations are asynchronous.

- Gateway returns `202 Accepted` + `jobId`.
- SpecBooks polls `GET /api/specbooks/jobs/{jobId}` for final status.

## Base URL and Auth

Base URL:

- `https://<gateway-host>`

Required header on every request:

- `X-SPECBOOKS-API-KEY: <shared secret>`

If missing or invalid:

- `401 Unauthorized`

## Rate Limits and Retry Guidance

Gateway applies per-route fixed-window limits and returns `429` when exceeded.

Headers on `429`:

- `Retry-After: <seconds>`

Current configured defaults (adjustable by env):

- `GET /customers/{customerId}`: 30 requests/min
- `GET /opportunities/{opportunityId}`: 30 requests/min
- `POST /opportunities`: 20 requests/min
- `PATCH /opportunities/{opportunityId}`: 20 requests/min

Worker-side Acumatica protection:

- Vendor cap: `VENDOR_MAX_CONCURRENCY=8`, `VENDOR_MAX_RPM=90`
- Global cap: `GLOBAL_MAX_CONCURRENCY=12`, `GLOBAL_MAX_RPM=200`

Client retry guidance:

- Retry on `429`, `500`, `503` with exponential backoff + jitter.
- Do not retry `400` or `401` until request/auth is fixed.

## Endpoints

Only these endpoints are supported:

1. `GET /api/specbooks/customers/{customerId}`
2. `GET /api/specbooks/opportunities/{opportunityId}`
3. `POST /api/specbooks/opportunities`
4. `PATCH /api/specbooks/opportunities/{opportunityId}`
5. `GET /api/specbooks/jobs/{jobId}`

## Request Schemas

### GET customer

- Path param: `customerId` (string, required)
- Response: `202 { "jobId": "<uuid>" }`

### GET opportunity

- Path param: `opportunityId` (string, required)
- Response: `202 { "jobId": "<uuid>" }`

### POST opportunity (create)

Required headers:

- `Idempotency-Key: <client-generated-unique-key>`

Body allowlist (unknown fields rejected):

- `Subject: { value: string }`
- `ClassID: { value: string }`
- `BusinessAccount: { value: string }`
- `Location: { value: string }`
- `Owner: { value: string }`
- `Products: [{ InventoryID: { value: string }, Quantity?: { value: number }, UOM?: { value: string } }]` (min 1)
- `ContactInformation?: { FirstName?: { value: string }, LastName?: { value: string }, CompanyName?: { value: string }, Email?: { value: string }, Phone1?: { value: string } }`
- `Address?: { AddressLine1?: { value: string }, AddressLine2?: { value: string }, City?: { value: string }, State?: { value: string }, PostalCode?: { value: string }, Country?: { value: string } }`
- `Hold?: { value: boolean }`

String constraints:

- min length `1`, max length `MAX_STRING_LENGTH` (default `2048`)
- max body size `MAX_REQUEST_BYTES` (default `102400`)

Idempotency behavior:

- Same `Idempotency-Key` for vendor `specbooks` returns the same existing `jobId` (no duplicate enqueue).

Response:

- `202 { "jobId": "<uuid>" }`

### PATCH opportunity (update)

- Path param `opportunityId` is authoritative.
- Body is partial update (at least one allowed field required).
- Unknown fields rejected.
- Allowed top-level fields:
  - `Subject`, `ClassID`, `BusinessAccount`, `Location`, `Owner`, `ContactInformation`, `Address`, `Hold`, `Products`
- `OpportunityID` in body is not allowed (use URL path only).
- `Products` line mutation fields:
  - `id?: string` (detail line identifier from `GET /opportunities` result; use this to update/delete existing lines)
  - `OpportunityProductID?: { value: number }` (exposed in GET result; informational only for client mapping)
  - `InventoryID?: { value: string }`
  - `Qty?: { value: number }`
  - `Quantity?: { value: number }`
  - `UOM?: { value: string }`
  - `Warehouse?: { value: string }`
  - `delete?: boolean`

Product-line semantics:

- Add a line: send a product item without `id` and with `InventoryID`.
- Update a line: send a product item with `id` and changed fields.
- Delete a line: send a product item with `id` and `"delete": true`.
- For update/delete operations, `id` should come from `GET /opportunities/{opportunityId}` -> `result[0].Products[].id`.

Response:

- `202 { "jobId": "<uuid>" }`

## Coalescing Behavior for PATCH

To avoid excessive Acumatica writes for repeated updates on the same opportunity:

- Updates are coalesced per `opportunityId`.
- Latest payload wins.
- Debounce window: `UPDATE_COALESCE_WINDOW_MS` (default `5000`).

Behavior:

1. Gateway `PATCH` upserts `OpportunityUpdateBuffer` with latest payload.
2. If an update job is already pending for that `opportunityId`, gateway does not enqueue another; it returns the existing `jobId`.
3. Worker waits for a quiet period equal to debounce window, then reads latest buffered payload and sends one Acumatica update.
4. If a newer payload arrives during processing, worker enqueues one follow-up update job and applies newest payload next.

Result:

- Intermediate payloads are superseded.
- Most recent payload at execution time is applied.

## Job Lifecycle and Polling

Poll endpoint:

- `GET /api/specbooks/jobs/{jobId}`

Response shape:

```json
{
  "jobId": "uuid",
  "vendorId": "specbooks",
  "type": "GET_CUSTOMER | GET_OPPORTUNITY | CREATE_OPPORTUNITY | UPDATE_OPPORTUNITY",
  "status": "queued | processing | succeeded | failed",
  "result": {},
  "error": "string | null",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

## Error Model

- `400` validation failure (schema/body/json/header requirements)
- `401` invalid or missing API key
- `404` unknown `jobId`
- `413` payload too large
- `429` rate limit exceeded (`Retry-After` provided)
- `500` internal gateway/worker failure

## Example Requests

Create opportunity:

```http
POST /api/specbooks/opportunities HTTP/1.1
X-SPECBOOKS-API-KEY: <key>
Idempotency-Key: c8d8a7a4-5e8c-4e20-a363-7f5f0f6fa4d9
Content-Type: application/json

{
  "Subject": { "value": "New Project" },
  "Products": [
    { "InventoryID": { "value": "SKU-100" }, "Quantity": { "value": 2 } }
  ]
}
```

Patch opportunity (update existing line + add new line):

```http
PATCH /api/specbooks/opportunities/OP11995 HTTP/1.1
X-SPECBOOKS-API-KEY: <key>
Content-Type: application/json

{
  "Products": [
    {
      "id": "aa252933-2909-f111-9fbe-6045bda28239",
      "Qty": { "value": 2 },
      "Warehouse": { "value": "SALT LAKE APPLIANCES" }
    },
    {
      "InventoryID": { "value": "ROOM" },
      "Qty": { "value": 1 },
      "Warehouse": { "value": "SALT LAKE APPLIANCES" }
    }
  ]
}
```

Patch opportunity (delete line):

```http
PATCH /api/specbooks/opportunities/OP11995 HTTP/1.1
X-SPECBOOKS-API-KEY: <key>
Content-Type: application/json

{
  "Products": [
    {
      "id": "88898d89-2909-f111-9fbe-6045bda28239",
      "delete": true
    }
  ]
}
```

Queue response:

```json
{ "jobId": "9c7d53f7-4cf8-4efd-a3be-5f100743da7d" }
```

Poll response (in progress):

```json
{
  "jobId": "9c7d53f7-4cf8-4efd-a3be-5f100743da7d",
  "vendorId": "specbooks",
  "type": "CREATE_OPPORTUNITY",
  "status": "processing",
  "result": null,
  "error": null,
  "createdAt": "2026-02-18T18:00:00.000Z",
  "updatedAt": "2026-02-18T18:00:05.000Z"
}
```

---

## Internal ERP API (WillCall Backend)

These endpoints are internal service-to-service endpoints used by `mld-willcall-backend`.

### Base URL and Auth

Base URL:

- `https://<queue-gateway-host>`

Required header on every `/api/erp/*` request:

- `Authorization: Bearer <MLD_QUEUE_TOKEN>`

If missing or invalid:

- `401 Unauthorized`

### Endpoint Contracts

1. `POST /api/erp/customers/verify`
- Request:
```json
{ "customerId": "BA0001318", "zip5": "84107" }
```
- Response:
```json
{ "ok": true, "matched": true }
```

2. `GET /api/erp/reports/order-ready`
- Response:
```json
{ "rows": [ { "OrderNbr": "SO38056", "ShipVia": "WILL CALL" } ] }
```

3. `GET /api/erp/orders/summaries?baid=BA0001318&pageSize=250&maxPages=50&useOrderBy=false`
- Response:
```json
{ "rows": [ { "OrderNbr": "SO38056", "Status": "Open" } ] }
```

4. `GET /api/erp/orders/summaries/delta?baid=BA0001318&since=datetimeoffset'2026-02-24T09:30:00-07:00'`
- Response:
```json
{ "rows": [ { "OrderNbr": "SO38056", "LastModified": { "value": "2026-02-24T16:17:24Z" } } ] }
```

5. `POST /api/erp/orders/payment-info`
- Request:
```json
{ "baid": "BA0001318", "orderNbrs": ["SO38056"] }
```
- Response:
```json
{ "rows": [ { "OrderNbr": "SO38056", "UnpaidBalance": { "value": 213.52 } } ] }
```

6. `POST /api/erp/orders/inventory-details`
- Request:
```json
{ "baid": "BA0001318", "orderNbrs": ["SO38056"] }
```
- Response:
```json
{ "rows": [ { "OrderNbr": "SO38056", "Details": [] } ] }
```

7. `POST /api/erp/orders/address-contact`
- Request:
```json
{ "baid": "BA0001318", "orderNbrs": ["SO38056"], "cutoffLiteral": null, "useOrderBy": false, "pageSize": 500 }
```
- Response:
```json
{ "rows": [ { "OrderNbr": "SO38056", "PostalCode": "84107" } ] }
```

8. `GET /api/erp/orders/last-modified?baid=BA0001318&orderNbr=SO38056`
- Response:
```json
{ "lastModified": "2026-02-24T16:17:24Z" }
```

9. `GET /api/erp/orders/header?orderNbr=SO38056`
- Response (found):
```json
{ "found": true, "row": { "OrderNbr": "SO38056", "CustomerID": "BA0001318" } }
```
- Response (not found):
```json
{ "found": false, "row": null }
```

### Error Model (`/api/erp/*`)

- `400` invalid query/body
- `401` missing/invalid bearer token
- `404` entity not found (where applicable)
- `429` rate limited
- `502` upstream Acumatica failure
- `500` internal queue error

Standard error payload:

```json
{ "error": "message", "code": "BAD_REQUEST|UNAUTHORIZED|NOT_FOUND|RATE_LIMITED|UPSTREAM_ERROR|INTERNAL_ERROR" }
```

### ERP Protection Controls (`/api/erp/*`)

Gateway enforces protection controls before calling Acumatica:

- Global max concurrency (`ERP_MAX_CONCURRENCY`, default `5`)
- Global max requests/minute (`ERP_MAX_RPM`, default `120`)
- Retry/backoff for transient failures (`429`, `5xx`, timeout)
- Per-endpoint timeout overrides with global default timeout

Environment variables:

- `ERP_MAX_CONCURRENCY`
- `ERP_MAX_RPM`
- `ERP_RETRY_MAX_ATTEMPTS`
- `ERP_RETRY_BASE_MS`
- `ERP_RETRY_MAX_MS`
- `ERP_TIMEOUT_DEFAULT_MS`
- `ERP_TIMEOUT_CUSTOMERS_VERIFY_MS`
- `ERP_TIMEOUT_REPORT_ORDER_READY_MS`
- `ERP_TIMEOUT_ORDERS_HEADER_MS`
- `ERP_TIMEOUT_ORDERS_LAST_MODIFIED_MS`
- `ERP_TIMEOUT_ORDERS_PAYMENT_INFO_MS`
- `ERP_TIMEOUT_ORDERS_INVENTORY_DETAILS_MS`
- `ERP_TIMEOUT_ORDERS_ADDRESS_CONTACT_MS`
- `ERP_TIMEOUT_ORDERS_SUMMARIES_MS`
- `ERP_TIMEOUT_ORDERS_SUMMARIES_DELTA_MS`

Gateway emits structured logs for observability:

- `erp_call_succeeded` (endpoint, status, durationMs, attempt)
- `erp_call_retry` (endpoint, attempt, delayMs, durationMs)
- `erp_call_failed` (endpoint, status, durationMs, transient)
- `erp_throttle_concurrency` (endpoint, active, maxConcurrency)
- `erp_throttle_rpm` (endpoint, rpmCount, maxRpm, retryAfterSeconds)
