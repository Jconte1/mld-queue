import { log } from "@/lib/logger";

const MAX_CONCURRENCY = Number(process.env.ERP_MAX_CONCURRENCY ?? 5);
const MAX_RPM = Number(process.env.ERP_MAX_RPM ?? 120);
const RETRY_MAX_ATTEMPTS = Number(process.env.ERP_RETRY_MAX_ATTEMPTS ?? 3);
const RETRY_BASE_MS = Number(process.env.ERP_RETRY_BASE_MS ?? 300);
const RETRY_MAX_MS = Number(process.env.ERP_RETRY_MAX_MS ?? 2500);
const DEFAULT_TIMEOUT_MS = Number(process.env.ERP_TIMEOUT_DEFAULT_MS ?? 25000);

const ENDPOINT_TIMEOUT_ENV: Record<string, string> = {
  "customers.verify": "ERP_TIMEOUT_CUSTOMERS_VERIFY_MS",
  "reports.order-ready": "ERP_TIMEOUT_REPORT_ORDER_READY_MS",
  "orders.header": "ERP_TIMEOUT_ORDERS_HEADER_MS",
  "orders.last-modified": "ERP_TIMEOUT_ORDERS_LAST_MODIFIED_MS",
  "orders.payment-info": "ERP_TIMEOUT_ORDERS_PAYMENT_INFO_MS",
  "orders.inventory-details": "ERP_TIMEOUT_ORDERS_INVENTORY_DETAILS_MS",
  "orders.address-contact": "ERP_TIMEOUT_ORDERS_ADDRESS_CONTACT_MS",
  "orders.summaries": "ERP_TIMEOUT_ORDERS_SUMMARIES_MS",
  "orders.summaries-delta": "ERP_TIMEOUT_ORDERS_SUMMARIES_DELTA_MS",
};

let active = 0;
let rpmWindowStart = 0;
let rpmCount = 0;

function nowMs() {
  return Date.now();
}

function computeRetryDelayMs(attempt: number) {
  const exp = RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(RETRY_MAX_MS, exp + jitter);
}

function isTransientError(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status <= 504);
  }

  const message = error instanceof Error ? error.message : String(error);
  return ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "timeout", "fetch failed"].some((token) =>
    message.toLowerCase().includes(token.toLowerCase())
  );
}

function resolveTimeoutMs(endpoint: string): number {
  const envName = ENDPOINT_TIMEOUT_ENV[endpoint];
  if (envName) {
    const v = Number(process.env[envName] ?? "");
    if (Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_TIMEOUT_MS;
}

function assertWithinRpm(endpoint: string) {
  const now = nowMs();
  const minute = Math.floor(now / 60000) * 60000;
  if (rpmWindowStart !== minute) {
    rpmWindowStart = minute;
    rpmCount = 0;
  }

  if (rpmCount >= MAX_RPM) {
    const retryAfterSeconds = Math.max(1, Math.ceil((rpmWindowStart + 60000 - now) / 1000));
    log("warn", "erp_throttle_rpm", {
      endpoint,
      maxRpm: MAX_RPM,
      retryAfterSeconds,
      rpmCount,
    });
    throw new Response(
      JSON.stringify({ error: "ERP rate limit exceeded", code: "RATE_LIMITED" }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSeconds),
        },
      }
    );
  }

  rpmCount += 1;
}

function assertWithinConcurrency(endpoint: string) {
  if (active >= MAX_CONCURRENCY) {
    log("warn", "erp_throttle_concurrency", {
      endpoint,
      maxConcurrency: MAX_CONCURRENCY,
      active,
    });
    throw new Response(
      JSON.stringify({ error: "ERP concurrency limit exceeded", code: "THROTTLED" }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "1",
        },
      }
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, endpoint: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const err = new Error(`ERP timeout after ${timeoutMs}ms (${endpoint})`) as Error & { status?: number };
      err.status = 504;
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function withErpProtection<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
  const start = nowMs();
  assertWithinConcurrency(endpoint);
  assertWithinRpm(endpoint);
  active += 1;

  let attempt = 0;
  try {
    while (true) {
      attempt += 1;
      const timeoutMs = resolveTimeoutMs(endpoint);
      try {
        const result = await withTimeout(fn(), timeoutMs, endpoint);
        log("info", "erp_call_succeeded", {
          endpoint,
          attempt,
          durationMs: nowMs() - start,
          status: 200,
          active,
          rpmCount,
        });
        return result;
      } catch (error) {
        const transient = isTransientError(error);
        if (!transient || attempt >= RETRY_MAX_ATTEMPTS) {
          const status = (error as { status?: number } | undefined)?.status ?? 500;
          log("error", "erp_call_failed", {
            endpoint,
            attempt,
            durationMs: nowMs() - start,
            status,
            transient,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        const delayMs = computeRetryDelayMs(attempt);
        log("warn", "erp_call_retry", {
          endpoint,
          attempt,
          delayMs,
          durationMs: nowMs() - start,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    active = Math.max(0, active - 1);
  }
}
