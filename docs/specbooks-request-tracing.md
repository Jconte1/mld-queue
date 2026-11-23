# Specbooks Request Tracing

The gateway logs requests for stock lookups/creation, opportunity creation/lookups/updates,
customer/contact/item-class lookups, and public job polling. These logs do not change
the API status, response body, headers, job payload, or queue behavior.

## Review a Failed Submission

1. In Vercel, choose the production gateway deployment and the submission's time window.
   Include warning/error events, not only informational enqueue messages. Account for
   the difference between the portal's local timestamps and the JSON UTC timestamp.
2. Find `gateway_request_started` for the relevant operation. Follow its `requestId`.
   `correlationId` and `vercelRequestId` are included when valid incoming headers exist.
   Each HTTP request gets its own generated ID; this is not a shared workflow ID.
3. Read `gateway_request_finished`: `httpStatus`, total handler `durationMs`, and `stage`.
   Authentication, validation, rate limiting, dedupe, enqueue, and polling are separate stages.
   Existing `gateway_job_enqueued.durationMs` measures queue publishing, not the entire request.
4. For rejections, inspect `gateway_request_error`, `gateway_validation_rejected`,
   `gateway_auth_rejected`, and `gateway_rate_limit_exceeded`. Validation logs name the
   reason and field paths/codes, not submitted values. Unexpected errors log type/code,
   safe cause code, and a message fingerprint rather than raw exception text.
5. `gateway_request_payload` contains a payload fingerprint, product/item counts, a
   normalized inventory-set fingerprint, and subject/manufacturer fingerprints where present.
   Use these to correlate repeats. The full-payload fingerprint is based on the parsed JSON
   and is property-order-sensitive; the inventory-set fingerprint ignores order and duplicates.
6. Follow the `jobId` from enqueue/reuse events into `gateway_job_polled`. Poll logs show
   the outward API job status, job age, last update, returned array count, and structured
   result name/status when present. They do not dump results or ERP errors.
7. Compare initial requested counts with returned counts. Batch stock lookups intentionally
   return only found items; an HTTP 200/succeeded job can therefore contain a partial list.
   Look for subsequent stock creations and finally `CREATE_OPPORTUNITY`.

## Interpret Gaps Carefully

- An enqueue event proves publication succeeded; it does not prove the caller received
  the response or later polled the job.
- A job can succeed after the caller stops waiting. Poll logs show whether the gateway
  actually handled a later status request, not whether the caller consumed the response.
- A rejected request can have request/error logs without a database job.
- A start with no finish may indicate a runtime termination, timeout, or missing log delivery;
  check Vercel invocation status before drawing a conclusion.
- `gateway_request_aborted` is best-effort notification from the platform's request signal.
  Its absence does not prove the browser/Specbooks stayed connected.
- These logs cannot reveal a Specbooks-side timeout that never reaches the gateway.
  No timeout values or lookup/creation behavior are changed by this instrumentation.

## Safety and Deployment

New tracing does not log API keys, authorization headers, query strings, complete request
or response payloads, customer names, prices, or raw exception messages. Treat fingerprints,
job IDs, and log access as sensitive operational data. Existing legacy events retain their
previous fields; this change is not a comprehensive redaction audit of all logging.

Polling creates a start, poll-outcome, and finish event per request. Monitor Vercel log volume
and retention during testing. This uses Vercel's existing log retention, not a new audit table.
Check the deployed commit and log availability before starting a controlled reproduction.
No database migration, worker image rebuild, or additional environment variable is required.

From `worker`, run the isolated no-network tests:

```powershell
npm.cmd exec -- tsx --tsconfig ../gateway/tsconfig.json scripts/validate-specbooks-request-tracing.ts
npm.cmd exec -- tsx --tsconfig ../gateway/tsconfig.json scripts/validate-stock-item-not-found.ts
```
