# Customer State Correction

One-time Customer endpoint cleanup from an Excel `Data` worksheet. The current
`state fix .xlsx` has 2,283 unique US customers with valid expected state codes.
Workbook content is data only; formulas or non-scalar values in input columns are
rejected. Nothing uses the spreadsheet's `Selected` column as an execution flag.

## Scope and Safety

- Only `Customer.MainContact.Address.State` is included in the update payload.
- Customer ID identifies an existing customer. The GET-returned entity `id` is
  used for PUT so this is not a create/upsert by an unverified customer key.
- Before changing State, the live address (country, street lines, city, postal
  code) and live State must match the workbook, ignoring case/extra whitespace.
- Already-correct states are no-ops. Changed addresses/states are reported as skips.
- Missing fields, ambiguous customers, failed requests, and failed verification
  are recorded as customer failures; the producer continues to the next customer.
  Queue/DB failures, timeouts and interrupted waits still stop further enqueueing.
- The worker GETs again after PUT; expected State and unchanged other address
  fields are verified. HTTP 200 alone does not mean success.
- No postal-code correction, customer-location update, contact reassignment,
  order update, notification send, or hold is requested. Acumatica customizations
  may have server-side side effects; a live single-customer test is required.

Customer nested address mapping follows Acumatica's documented MainContact/Address
contract: https://www.acumatica.com/media/2020/09/AcumaticaERP_IntegrationDevelopmentGuide.pdf
CustomEndpoint still needs the same fields exposed; unverified live mapping fails
closed. No live Customer GET/PUT has been run while implementing this script.

## Prerequisites

1. Review/apply queue migration `20261006160000_add_customer_state_correction_job`
   using `npm.cmd exec -- prisma migrate deploy` from mld-queue. This applies ALL
   pending migrations; inspect `prisma migrate status` first.
2. Run `npm.cmd exec -- prisma generate` locally. Rebuild/deploy the queue worker
   that consumes the selected queue, then start it when ready. An old generated
   Prisma client will not recognize the new job type.
3. The local producer needs `DATABASE_URL` (queue DB) and
   `AZURE_SERVICEBUS_CONNECTION_STRING` in worker/.env or the process environment.
   The worker continues using its existing Acumatica credentials/endpoint settings.
4. Explicit `--queue-name` is required for preview/apply. Use the exact queue
   consumed by the updated worker. For the delivery queue this is normally
   `mld-delivery-erp-jobs`; confirm the deployed worker configuration.

## Commands (mld-queue Repo Root)

Workbook-only inspection (default; no queue or database access):

```powershell
npm.cmd run correct:customer-states -- --file "C:\Users\james\Downloads\state fix .xlsx" --inspect
```

Preview five customers through queue-backed GETs. Creates queue bookkeeping rows,
but sends no ERP PUTs:

```powershell
npm.cmd run correct:customer-states -- --file "C:\Users\james\Downloads\state fix .xlsx" --preview --limit 5 --queue-name mld-delivery-erp-jobs
```

After reviewing preview, apply ONE customer and inspect the result in ERP:

```powershell
npm.cmd run correct:customer-states -- --file "C:\Users\james\Downloads\state fix .xlsx" --apply --limit 1 --queue-name mld-delivery-erp-jobs --confirm "APPLY CUSTOMER STATE CORRECTIONS"
```

Once verified, use the same apply command without `--limit 1` for the full workbook.
`--customer-id BA0004409` can target a specific workbook row. No customers outside
the workbook are discovered or updated. All rows are validated before the first job.

## Execution and Recovery

One outstanding customer at a time, with 10-second spacing between results by
default. `--spacing-ms` may be set to at least 1000. At 2,283 rows, default spacing
alone is about 6.3 hours; ERP/queue time adds to that.

`--timeout-seconds` defaults to 300. A timeout or Ctrl+C stops further enqueueing;
the outstanding queued job MAY STILL EXECUTE. Do not assume cancellation. Keep
the local process alive for the full run; it submits the next row after completion.

Apply job IDs are deterministic per file hash/sheet/customer/queue/run ID. Rerunning
the same command resumes/reuses existing jobs (reported as `reusedJob`), including
completed ones; counts can therefore include previous successes. Preview defaults
to a new run ID each invocation for fresh reads. Do not edit the workbook mid-run.

If a job failed, inspect its report/queue row and fix the cause before deliberately
using a new `--run-id retry-1`. Fresh GETs then protect against overwriting changed
data. An uncertain Service Bus send leaves the queue row in place, not falsely
failed; inspect the queue before any new run. Do not automatically delete/replay it.

CSV recaps and detailed JSONL reports are under `worker/reports/customer-state-fix/` (gitignored) and include
customer ID, spreadsheet row, job ID, old/expected/readback state, outcome and errors.
They are local sensitive operational artifacts; do not commit or publicly share.
CSV rows are flushed after every completed customer, so the partial recap remains
available after an interruption. Each includes BA number, source row, old/expected/
readback State, outcome, concise error, job ID and whether the job was reused.
`completed_with_errors` means the selected list finished but contains failed
customers; the process exits nonzero after finishing, not at the first failed row.

Validation: `npm.cmd run validate:customer-state-correction` uses synthetic Excel
data and mocked ERP reads/writes, with live network fetch forbidden.
