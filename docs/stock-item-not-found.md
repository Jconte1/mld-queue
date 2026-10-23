# Stock Item Not Found: Database Classification

For `GET_STOCK_ITEM`, a `StockItemNotFoundError` with status `404` is stored
as `jobs.status = 'succeeded'`: the lookup completed and did not find an item.
The original `error` string and `result` (including its 404 and attempt
metadata) are preserved. A non-null error on this specific successful lookup
is expected; it is the existing not-found information, not an ERP write result.

## Specbooks Contract Is Unchanged

Both job-polling routes use `getJobById`, which presents these records using
the previous `status = 'failed'` response, with the same error and result.
The HTTP status, response shape, lookup and creation endpoints, inventory ID
handling, and ERP calls are unchanged. Specbooks still sees not found and
can request creation exactly as before.

Not-found results are excluded from stock-lookup reuse, even though stored
as succeeded. A verification lookup after creation must run again, not reuse
the earlier miss. Normal successful and in-flight lookup reuse is unchanged.

Other error types and job types retain their existing failure handling.
This change does not alter the Acumatica client's fallback behavior: that
code can already mask underlying lookup request errors as not found. It
does not introduce a new guarantee that every reported miss is authoritative.

## Deployment Order

1. Deploy the gateway compatibility/reuse changes first and verify Vercel is Ready.
2. Rebuild and deploy the worker with the database-classification change.

No migration is required. Do not deploy the worker first: an old gateway
would expose the new stored status directly to Specbooks. Old workers
already store failed, so the gateway-first order remains compatible.

Existing records are not reclassified by deployment. Review them separately
after both applications are deployed; preserve their error and result.

## Regression Check

From `worker`, using the gateway TypeScript paths for the mocked gateway checks:

```powershell
npm.cmd exec -- tsx --tsconfig ../gateway/tsconfig.json scripts/validate-stock-item-not-found.ts
```

The check uses mocked database reads and does not enqueue jobs or call ERP.
