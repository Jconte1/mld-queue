import {
  buildDeliveryIntervalRunnerArgs,
  normalizeDeliveryScheduledIntervalPayload,
  processDeliveryScheduledIntervalJob,
} from "../src/lib/deliveryScheduledInterval";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const payload = {
  interval: "90",
  runDate: "2026-09-01",
  timezone: "America/Denver",
  expectedLocalTime: "15:10",
  manualRun: true,
  schedulerRunId: "scheduler_123",
  lockKey: "delivery_interval_cron:90:2026-09-01",
  send: true,
  confirmationPhrase: "RUN REAL 90 DAY CUSTOMER NOTIFICATIONS",
  requestedBy: "manual",
  orderScope: {
    orderType: "so",
    orderNumber: "so38056",
  },
};

async function main() {
  const normalized = normalizeDeliveryScheduledIntervalPayload(payload);
  assert(normalized.interval === "90", "interval normalizes");
  assert(normalized.runDate === "2026-09-01", "runDate preserved");
  assert(normalized.orderScope?.orderType === "SO", "orderType uppercases");
  assert(normalized.orderScope?.orderNumber === "SO38056", "orderNumber uppercases");

  const args = buildDeliveryIntervalRunnerArgs(normalized);
  assert(args.includes("run:delivery-interval"), "worker delegates to delivery interval runner");
  assert(args.includes("--send"), "worker delegates a live send command");
  assert(args.includes("--confirm"), "worker includes exact confirmation phrase");
  assert(args.includes("RUN REAL 90 DAY CUSTOMER NOTIFICATIONS"), "worker includes 90-day phrase");
  assert(args.includes("--order-type") && args.includes("SO"), "worker passes order scope type");
  assert(args.includes("--order-number") && args.includes("SO38056"), "worker passes order scope number");

  let commandCalled = false;
  let statusUpdate: unknown = null;
  const result = await processDeliveryScheduledIntervalJob(payload, {
    deliveryAppProjectDir: "C:\\delivery",
    runCommand: ({ command, args: commandArgs, cwd }) => {
      commandCalled = true;
      assert(command.includes("npm"), "worker uses npm command");
      assert(cwd === "C:\\delivery", "worker uses configured delivery app directory");
      assert(commandArgs.includes("run:delivery-interval"), "worker command uses shared CLI");
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, providerCalls: 0 }),
        stderr: "",
        error: null,
      };
    },
    updateSchedulerRunStatus: async (update) => {
      statusUpdate = update;
    },
  });

  assert(commandCalled, "worker handler should execute injected runner");
  assert(result.ok === true, "worker handler should report successful run");
  assert(
    (statusUpdate as { status?: string } | null)?.status === "success",
    "worker handler should mark scheduler run success"
  );

  let failedStatus: unknown = null;
  try {
    await processDeliveryScheduledIntervalJob(payload, {
      deliveryAppProjectDir: "C:\\delivery",
      runCommand: () => ({
        status: 1,
        stdout: "",
        stderr: "failed",
        error: null,
      }),
      updateSchedulerRunStatus: async (update) => {
        failedStatus = update;
      },
    });
  } catch {
    // Expected.
  }
  assert(
    (failedStatus as { status?: string } | null)?.status === "failed",
    "worker handler should mark scheduler run failed"
  );

  assert(
    !JSON.stringify(result).includes("twilio.messages.create"),
    "validation must not call providers"
  );

  console.log(
    "Delivery scheduled interval queue job validation passed. No SMS/email/provider calls, Acumatica writes, holds, deploys, or production data mutations were performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
