import { spawnSync } from "node:child_process";
import { Client } from "pg";

const INTERVALS = ["180", "90", "60", "42", "30", "14", "12", "10", "2"] as const;
type ScheduledInterval = (typeof INTERVALS)[number];

const CONFIRMATION_PHRASES: Record<ScheduledInterval, string> = {
  "180": "RUN REAL 180 DAY CUSTOMER NOTIFICATIONS",
  "90": "RUN REAL 90 DAY CUSTOMER NOTIFICATIONS",
  "60": "RUN REAL 60 DAY CUSTOMER NOTIFICATIONS",
  "42": "RUN REAL 42 DAY CUSTOMER CONFIRMATION NOTIFICATIONS",
  "30": "RUN REAL 30 DAY CUSTOMER NOTIFICATIONS",
  "14": "RUN REAL 14 DAY CUSTOMER NOTIFICATIONS",
  "12": "RUN REAL 12 DAY CUSTOMER NOTIFICATIONS",
  "10": "RUN REAL 10 DAY CUSTOMER NOTIFICATIONS",
  "2": "RUN REAL 2 DAY CUSTOMER NOTIFICATIONS",
};

type SchedulerRunStatus = "success" | "failed";

export type DeliveryScheduledIntervalPayload = {
  interval: ScheduledInterval;
  runDate: string;
  timezone: string;
  expectedLocalTime: string;
  manualRun: boolean;
  schedulerRunId: string;
  lockKey: string;
  send: true;
  confirmationPhrase: string;
  requestedBy: "vercel-cron" | "manual";
  orderScope?: {
    orderType: string;
    orderNumber: string;
  };
};

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

type SchedulerStatusUpdater = (params: {
  schedulerRunId: string;
  status: SchedulerRunStatus;
  resultSummary: unknown;
  errorMessage?: string | null;
}) => Promise<void>;

type CommandRunner = (params: {
  command: string;
  args: string[];
  cwd: string;
}) => CommandResult;

export type ProcessDeliveryScheduledIntervalJobOptions = {
  updateSchedulerRunStatus?: SchedulerStatusUpdater;
  runCommand?: CommandRunner;
  deliveryAppProjectDir?: string;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBoolean(value: unknown, field: string) {
  if (value !== true && value !== false) throw new Error(`${field} must be boolean`);
  return value;
}

function normalizeInterval(value: unknown): ScheduledInterval {
  const interval = clean(value);
  if (interval === "8") throw new Error("interval_8_not_schedule_ready");
  if (!INTERVALS.includes(interval as ScheduledInterval)) {
    throw new Error(`interval must be one of ${INTERVALS.join(", ")}`);
  }
  return interval as ScheduledInterval;
}

function requireString(payload: Record<string, unknown>, field: string) {
  const value = clean(payload[field]);
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function redactSensitiveText(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "<redacted-phone>")
    .slice(0, 10_000);
}

function parseCommandJson(output: string) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { output: redactSensitiveText(trimmed) };
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return { output: redactSensitiveText(trimmed) };
  }
}

export function normalizeDeliveryScheduledIntervalPayload(
  payload: unknown
): DeliveryScheduledIntervalPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload is required");
  }
  const record = payload as Record<string, unknown>;
  const interval = normalizeInterval(record.interval);
  const runDate = requireString(record, "runDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error("runDate must be YYYY-MM-DD");
  const expectedLocalTime = requireString(record, "expectedLocalTime");
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(expectedLocalTime)) {
    throw new Error("expectedLocalTime must be HH:mm");
  }
  const confirmationPhrase = requireString(record, "confirmationPhrase");
  if (confirmationPhrase !== CONFIRMATION_PHRASES[interval]) {
    throw new Error(`confirmationPhrase does not match interval ${interval}`);
  }
  const requestedBy = requireString(record, "requestedBy");
  if (requestedBy !== "vercel-cron" && requestedBy !== "manual") {
    throw new Error("requestedBy must be vercel-cron or manual");
  }

  const normalized: DeliveryScheduledIntervalPayload = {
    interval,
    runDate,
    timezone: requireString(record, "timezone"),
    expectedLocalTime,
    manualRun: normalizeBoolean(record.manualRun, "manualRun"),
    schedulerRunId: requireString(record, "schedulerRunId"),
    lockKey: requireString(record, "lockKey"),
    send: normalizeBoolean(record.send, "send") as true,
    confirmationPhrase,
    requestedBy,
  };
  if (normalized.send !== true) throw new Error("send must be true");

  const orderScope = record.orderScope;
  if (orderScope !== undefined) {
    if (!orderScope || typeof orderScope !== "object" || Array.isArray(orderScope)) {
      throw new Error("orderScope must be an object");
    }
    const scoped = orderScope as Record<string, unknown>;
    normalized.orderScope = {
      orderType: requireString(scoped, "orderType").toUpperCase(),
      orderNumber: requireString(scoped, "orderNumber").toUpperCase(),
    };
  }

  return normalized;
}

export function buildDeliveryIntervalRunnerArgs(payload: DeliveryScheduledIntervalPayload) {
  const args = [
    "run",
    "run:delivery-interval",
    "--",
    "--interval",
    payload.interval,
    "--run-date",
    payload.runDate,
    "--send",
    "--confirm",
    payload.confirmationPhrase,
  ];
  if (payload.orderScope) {
    args.push(
      "--order-type",
      payload.orderScope.orderType,
      "--order-number",
      payload.orderScope.orderNumber
    );
  }
  return args;
}

function defaultDeliveryAppProjectDir() {
  const value = process.env.DELIVERY_APP_PROJECT_DIR?.trim();
  if (!value) throw new Error("DELIVERY_APP_PROJECT_DIR is required for RUN_DELIVERY_INTERVAL_SCHEDULED");
  return value;
}

function defaultRunCommand(params: { command: string; args: string[]; cwd: string }): CommandResult {
  const result = spawnSync(params.command, params.args, {
    cwd: params.cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? result.error.message : null,
  };
}

export async function updateDeliverySchedulerRunStatus(params: {
  schedulerRunId: string;
  status: SchedulerRunStatus;
  resultSummary: unknown;
  errorMessage?: string | null;
}) {
  const connectionString = process.env.DELIVERY_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DELIVERY_DATABASE_URL is required to update delivery scheduler run status");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `
        UPDATE "delivery_interval_scheduler_runs"
        SET
          "status" = CASE
            WHEN $2 = 'success' THEN 'success'::"DeliveryIntervalSchedulerRunStatus"
            ELSE 'failed'::"DeliveryIntervalSchedulerRunStatus"
          END,
          "completedAt" = CASE WHEN $2 = 'success' THEN now() ELSE "completedAt" END,
          "failedAt" = CASE WHEN $2 = 'failed' THEN now() ELSE "failedAt" END,
          "resultSummary" = $3::jsonb,
          "errorMessage" = $4,
          "updatedAt" = now()
        WHERE "id" = $1
      `,
      [
        params.schedulerRunId,
        params.status,
        JSON.stringify(params.resultSummary ?? null),
        redactSensitiveText(params.errorMessage) ?? null,
      ]
    );
  } finally {
    await client.end();
  }
}

export async function processDeliveryScheduledIntervalJob(
  payload: unknown,
  options: ProcessDeliveryScheduledIntervalJobOptions = {}
) {
  const normalized = normalizeDeliveryScheduledIntervalPayload(payload);
  const args = buildDeliveryIntervalRunnerArgs(normalized);
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const cwd = options.deliveryAppProjectDir ?? defaultDeliveryAppProjectDir();
  const updateStatus = options.updateSchedulerRunStatus ?? updateDeliverySchedulerRunStatus;

  const result = (options.runCommand ?? defaultRunCommand)({ command, args, cwd });
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
  const resultSummary = {
    ok: result.status === 0 && !result.error,
    interval: normalized.interval,
    runDate: normalized.runDate,
    schedulerRunId: normalized.schedulerRunId,
    lockKey: normalized.lockKey,
    requestedBy: normalized.requestedBy,
    manualRun: normalized.manualRun,
    command,
    args,
    cwd,
    childExitStatus: result.status,
    childError: redactSensitiveText(result.error),
    childResultSummary: parseCommandJson(combinedOutput),
    sensitiveValuesPrinted: false,
  };

  if (resultSummary.ok) {
    await updateStatus({
      schedulerRunId: normalized.schedulerRunId,
      status: "success",
      resultSummary,
    });
    return resultSummary;
  }

  const errorMessage = result.error ?? `run:delivery-interval failed with exit status ${result.status}`;
  await updateStatus({
    schedulerRunId: normalized.schedulerRunId,
    status: "failed",
    resultSummary,
    errorMessage,
  });
  throw new Error(errorMessage);
}
