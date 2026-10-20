# Resolved Jobs

`resolved` is a terminal review status for a job that failed, but whose issue
has subsequently been addressed. It is not equivalent to `succeeded`: the
original job did not necessarily execute successfully.

Use it for reviewed duplicate failures after another submission succeeded,
or for a failure corrected outside the queue after verifying the outcome.
Knowing the cause alone (for example, a customer still on Credit Hold) does
not mean an outstanding failure is resolved.

## Mark a Reviewed Failure Resolved

After the migration and deployments below, change only explicitly reviewed
failed jobs. In PostgreSQL, substitute the exact job ID:

```sql
UPDATE jobs
SET status = 'resolved', "updatedAt" = NOW()
WHERE id = '<reviewed-job-id>' AND status = 'failed'
RETURNING id, type, status, error, "updatedAt";
```

This preserves `payload`, `result`, `error`, and `createdAt`. The timestamp
records the latest change, not the original failure time. Document the
resolution reason and any replacement job/invoice ID in the investigation
record before changing status; no separate resolution-note column exists.

Do not mark queued or processing jobs resolved. This is historical cleanup,
not cancellation of work already running. The worker completes any later
queue delivery for a resolved job without running its ERP operation.

Filter `status = 'failed'` for outstanding failures, and `status = 'resolved'`
for reviewed history. Approving a mapping does not automatically resolve
old failed submissions. New jobs for the same payload are still allowed;
resolved jobs are not treated as reusable successful stock-item results.

## Deployment

From `worker`:

```powershell
npm.cmd exec -- prisma migrate deploy --schema ../prisma/schema.prisma
```

Deploy the updated gateway and rebuild/redeploy the worker (both generate
Prisma clients during their builds). Apply the additive migration and deploy
both applications before assigning the new status to existing rows. Any
external job-status consumers must also handle `resolved` as terminal,
without treating its preserved error result as a successful ERP response.

Adding this status does not reclassify any existing jobs or retry any work.
