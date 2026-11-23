import { createHash, randomUUID } from "node:crypto";
import { log } from "./logger";
import { requestContext, type RequestTrace } from "./requestContext";

const pollSummaries = new Map<string, { signature: string; loggedAt: number; suppressed: number }>();
const POLL_SUMMARY_INTERVAL_MS = 30_000;
const MAX_POLL_SUMMARIES = 1_000;

function safeId(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9:_.;=/-]{1,200}$/.test(value) ? value : undefined;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

export function traceStage(stage: string): void {
  const trace = requestContext.getStore();
  if (trace) trace.stage = stage;
}

export function tracePayload(payload: Record<string, unknown>): void {
  // Fingerprints allow comparisons without logging customer names, prices, or raw payloads.
  const inventoryIds = Array.isArray(payload.inventoryIds)
    ? [...new Set(payload.inventoryIds.map(id => String(id).trim().toUpperCase()))].sort()
    : undefined;
  log("info", "gateway_request_payload", {
    payloadFingerprint: fingerprint(payload),
    inventoryIdCount: inventoryIds?.length,
    inventoryIdsFingerprint: inventoryIds ? fingerprint(inventoryIds) : undefined,
    productCount: Array.isArray(payload.Products) ? payload.Products.length : undefined,
    subjectFingerprint: payload.Subject ? fingerprint(payload.Subject) : undefined,
    manufacturerFingerprint: payload.manufacturer ? fingerprint(payload.manufacturer) : undefined,
  });
}

export function traceRequestError(error: unknown): void {
  // Error messages may contain database URLs, submitted values, or ERP response payloads.
  const candidate = error as { name?: unknown; code?: unknown; status?: unknown; cause?: { code?: unknown } } | null;
  log(error instanceof Response && error.status < 500 ? "warn" : "error", "gateway_request_error", {
    errorName: error instanceof Response ? "HttpRejection" : safeId(typeof candidate?.name === "string" ? candidate.name : null) ?? "UnknownError",
    errorCode: safeId(typeof candidate?.code === "string" ? candidate.code : null),
    causeCode: safeId(typeof candidate?.cause?.code === "string" ? candidate.cause.code : null),
    errorFingerprint: error instanceof Error ? fingerprint(error.message) : undefined,
    httpStatus: error instanceof Response ? error.status : typeof candidate?.status === "number" ? candidate.status : undefined,
  });
}

export function traceValidationFailure(reason: string, issues: { path: (string | number)[]; code: string }[] = []): void {
  if (!requestContext.getStore()) return;
  log("warn", "gateway_validation_rejected", {
    reason,
    issues: issues.slice(0, 30).map(issue => ({
      path: issue.path.map(part => String(part).slice(0, 80)).join("."), code: issue.code,
    })),
    issueCount: issues.length,
  });
}

export function traceJobId(jobId: string): void {
  const trace = requestContext.getStore();
  if (trace) trace.jobId = jobId;
}

export function traceJobPoll(jobId: string, job: {
  type: string; status: string; createdAt: Date; updatedAt: Date; result: unknown;
} | null): void {
  const result = job?.result as { name?: unknown; status?: unknown } | null;
  const now = Date.now();
  const signature = JSON.stringify([job?.status, job?.updatedAt.toISOString(), result?.name, result?.status]);
  const previous = pollSummaries.get(jobId);
  if (previous?.signature === signature && now - previous.loggedAt < POLL_SUMMARY_INTERVAL_MS) {
    previous.suppressed++;
    return;
  }
  // Best-effort aggregation within one warm instance; never persist or alter polling results.
  pollSummaries.delete(jobId);
  pollSummaries.set(jobId, { signature, loggedAt: now, suppressed: 0 });
  if (pollSummaries.size > MAX_POLL_SUMMARIES) pollSummaries.delete(pollSummaries.keys().next().value!);
  log("info", "gateway_job_polled", {
    jobId, found: Boolean(job), jobType: job?.type, jobStatus: job?.status,
    jobAgeMs: job ? Date.now() - job.createdAt.getTime() : undefined,
    jobUpdatedAt: job?.updatedAt.toISOString(),
    returnedItemCount: Array.isArray(job?.result) ? job.result.length : undefined,
    resultName: safeId(typeof result?.name === "string" ? result.name : null),
    resultStatus: typeof result?.status === "number" ? result.status : undefined,
    suppressedPollCount: previous?.suppressed ?? 0,
  });
}

export function withSpecbooksRequest<T extends unknown[]>(
  operation: string,
  handler: (request: Request, ...args: T) => Promise<Response>,
  routeTemplate?: string,
): (request: Request, ...args: T) => Promise<Response> {
  return async (request, ...args) => {
    const trace: RequestTrace = {
      requestId: randomUUID(), operation, method: request.method,
      route: routeTemplate ?? (operation === "POLL_JOB" ? "/api/specbooks/jobs/[jobId]"
        : operation === "GET_STOCK_ITEM" ? "/api/specbooks/stock-items/[inventoryId]"
        : operation === "CREATE_STOCK_ITEM" ? "/api/specbooks/stock-items"
        : "/api/specbooks/opportunities"),
      correlationId: safeId(request.headers.get("x-correlation-id")),
      vercelRequestId: safeId(request.headers.get("x-vercel-id")),
      stage: "authentication",
    };
    return requestContext.run(trace, async () => {
      const startedAt = Date.now();
      const isPoll = operation === "POLL_JOB";
      if (!isPoll) log("info", "gateway_request_started");
      const slowTimer = isPoll ? setTimeout(() => {
        log("warn", "gateway_request_slow", { durationMs: Date.now() - startedAt, thresholdMs: 2000 });
      }, 2000) : undefined;
      const aborted = () => requestContext.run(trace, () =>
        log("warn", "gateway_request_aborted", { durationMs: Date.now() - startedAt }));
      request.signal.addEventListener("abort", aborted, { once: true });
      if (request.signal.aborted) aborted();
      try {
        const response = await handler(request, ...args);
        if (!isPoll || response.status >= 400 || Date.now() - startedAt >= 2000) {
          log(response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
            "gateway_request_finished", {
              httpStatus: response.status, durationMs: Date.now() - startedAt,
              requestAborted: request.signal.aborted,
            });
        }
        return response;
      } catch (error) {
        traceRequestError(error);
        log("error", "gateway_request_unhandled", { durationMs: Date.now() - startedAt });
        throw error;
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
        request.signal.removeEventListener("abort", aborted);
      }
    });
  };
}
