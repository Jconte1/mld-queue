import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildDeliveryPrepaymentHoldAcumaticaPayload,
  DELIVERY_PREPAYMENT_HOLD_REASON,
  normalizeDeliveryPrepaymentHoldPayload,
  processDeliveryPrepaymentHoldJob,
  type DeliveryPrepaymentHoldState,
} from "../src/lib/deliveryPrepaymentHold";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  assert(
    Object.is(actual, expected),
    `${message}: expected ${String(expected)}, got ${String(actual)}`
  );
}

function assertIncludes(source: string, expected: string, message: string) {
  assert(source.includes(expected), `${message}: expected ${expected}`);
}

function assertThrows(fn: () => unknown, message: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

class MockAcumaticaClient {
  states: DeliveryPrepaymentHoldState[];
  statesAfterPut: DeliveryPrepaymentHoldState[];
  putCalls = 0;
  readCalls = 0;
  lastPayload: Record<string, unknown> | null = null;

  constructor(
    states: DeliveryPrepaymentHoldState[],
    statesAfterPut: DeliveryPrepaymentHoldState[] = states
  ) {
    this.states = states;
    this.statesAfterPut = statesAfterPut;
  }

  async fetchDeliveryPrepaymentHoldStates() {
    this.readCalls += 1;
    return this.putCalls > 0 ? this.statesAfterPut : this.states;
  }

  async putDeliveryPrepaymentHold(payload: Record<string, unknown>) {
    this.putCalls += 1;
    this.lastPayload = payload;
    return {
      status: 200,
      body: {
        OrderType: { value: "SO" },
        OrderNbr: { value: "SO38056" },
        Status: { value: "On Hold" },
        Hold: { value: true },
      },
    };
  }
}

class HangingAcumaticaClient {
  readCalls = 0;
  putCalls = 0;

  async fetchDeliveryPrepaymentHoldStates(): Promise<DeliveryPrepaymentHoldState[]> {
    this.readCalls += 1;
    return new Promise(() => {
      // Intentionally never resolves; dry-run validation proves this is never awaited.
    });
  }

  async putDeliveryPrepaymentHold(): Promise<{ status: number; body: unknown }> {
    this.putCalls += 1;
    throw new Error("dry-run must not call PUT");
  }
}

const openState: DeliveryPrepaymentHoldState = {
  orderType: "SO",
  orderNumber: "SO38056",
  status: "Awaiting Payment",
  hold: false,
  holdExposed: true,
};

const heldState: DeliveryPrepaymentHoldState = {
  orderType: "SO",
  orderNumber: "SO38056",
  status: "On Hold",
  hold: true,
  holdExposed: true,
};

const holdNotExposedState: DeliveryPrepaymentHoldState = {
  orderType: "SO",
  orderNumber: "SO38056",
  status: "Awaiting Payment",
  hold: null,
  holdExposed: false,
};

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const schema = readFileSync(path.join(repoRoot, "prisma/schema.prisma"), "utf8");
  const gatewayTypes = readFileSync(path.join(repoRoot, "gateway/src/lib/types.ts"), "utf8");
  const workerTypes = readFileSync(path.join(repoRoot, "worker/src/types.ts"), "utf8");
  const route = readFileSync(
    path.join(repoRoot, "gateway/src/app/api/erp/jobs/delivery/prepayment-hold/route.ts"),
    "utf8"
  );
  const workerSource = readFileSync(
    path.join(repoRoot, "worker/src/lib/deliveryPrepaymentHold.ts"),
    "utf8"
  );
  const acumaticaClient = readFileSync(
    path.join(repoRoot, "worker/src/lib/acumaticaClient.ts"),
    "utf8"
  );
  const workerSwitch = readFileSync(path.join(repoRoot, "worker/src/worker.ts"), "utf8");
  const envExample = readFileSync(path.join(repoRoot, "worker/.env.example"), "utf8");
  const rootPackage = readFileSync(path.join(repoRoot, "package.json"), "utf8");

  for (const source of [schema, gatewayTypes, workerTypes, workerSwitch]) {
    assertIncludes(
      source,
      "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD",
      "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD wiring"
    );
  }

  assertIncludes(route, "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD", "gateway route enqueues hold job");
  assertIncludes(route, "z.literal(PAYMENT_ENFORCEMENT_REASON)", "gateway validates exact reason");
  assertIncludes(route, "dryRun: z.boolean().optional().default(true)", "gateway dryRun default");
  assertIncludes(route, ".strict()", "gateway rejects batch/extra payloads");
  assertIncludes(workerSource, "ACUMATICA_PREPAYMENT_HOLD_DRY_RUN", "worker dry-run env");
  assertIncludes(workerSource, "ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED", "worker write env");
  assertIncludes(workerSource, "ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER", "worker allowlist env");
  assertIncludes(workerSource, "stateReadSkipped", "safe paths report skipped Acumatica state reads");
  assertIncludes(
    workerSource,
    "TODO: Replace existing On Hold write target with configured Prepayment Hold status/action once Acumatica configuration is complete.",
    "future Prepayment Hold TODO"
  );
  assert(!workerSource.includes("Hold: { value: false }"), "worker must not implement Hold=false");
  assertIncludes(acumaticaClient, "$select: \"OrderNbr,OrderType,Status,Hold\"", "hold read select");
  assertIncludes(workerSwitch, "case \"ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD\"", "worker switch has hold case");
  assertIncludes(workerSwitch, "return processDeliveryPrepaymentHoldJob", "worker switch awaits/returns hold handler");
  assertIncludes(workerSwitch, "Unsupported job type", "unknown job types fail cleanly");
  assertIncludes(workerSwitch, "status: \"succeeded\"", "worker persists succeeded status");
  assertIncludes(workerSwitch, "result: toPrismaJsonValue(result)", "worker persists serializable result");
  assertIncludes(workerSwitch, "status: \"failed\"", "worker persists failed status");
  assertIncludes(workerSwitch, "error: message.slice(0, MAX_STORED_ERROR_CHARS)", "worker persists bounded error message");
  assertIncludes(envExample, "ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED=false", "write env doc");
  assertIncludes(envExample, "ACUMATICA_PREPAYMENT_HOLD_DRY_RUN=true", "dry-run env doc");
  assertIncludes(
    envExample,
    "ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER=",
    "allowlist env doc"
  );
  assertIncludes(rootPackage, "validate:delivery-prepayment-hold", "root package validation script");

  assertThrows(
    () =>
      normalizeDeliveryPrepaymentHoldPayload({
        orderType: "",
        orderNumber: "SO38056",
        reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      }),
    "blank orderType should reject"
  );
  assertThrows(
    () =>
      normalizeDeliveryPrepaymentHoldPayload({
        orderType: "SO",
        orderNumber: "",
        reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      }),
    "blank orderNumber should reject"
  );
  assertThrows(
    () =>
      normalizeDeliveryPrepaymentHoldPayload({
        orderType: "SO",
        orderNumber: "SO38056",
        reason: "bad_reason",
      }),
    "invalid reason should reject"
  );

  const normalized = normalizeDeliveryPrepaymentHoldPayload({
    orderType: " so ",
    orderNumber: " so38056 ",
    reason: DELIVERY_PREPAYMENT_HOLD_REASON,
  });
  assertEqual(normalized.orderType, "SO", "orderType normalizes");
  assertEqual(normalized.orderNumber, "SO38056", "orderNumber normalizes");
  assertEqual(normalized.dryRun, true, "dryRun defaults safe");

  const plannedPayload = buildDeliveryPrepaymentHoldAcumaticaPayload(normalized);
  assertEqual(
    JSON.stringify(plannedPayload),
    JSON.stringify({
      OrderType: { value: "SO" },
      OrderNbr: { value: "SO38056" },
      Hold: { value: true },
    }),
    "planned payload is minimal Hold=true payload"
  );

  const dryRunClient = new MockAcumaticaClient([openState]);
  const dryRun = await processDeliveryPrepaymentHoldJob(
    {
      orderType: "SO",
      orderNumber: "SO38056",
      reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      dryRun: true,
    },
    dryRunClient,
    {}
  );
  assertEqual(dryRun.status, "dry_run", "dry-run status");
  assertEqual(dryRun.reason, "dry_run", "dry-run reason");
  assertEqual(dryRunClient.putCalls, 0, "dry-run does not call PUT");
  assertEqual(dryRunClient.readCalls, 0, "dry-run does not call Acumatica GET");
  assertEqual(dryRun.wouldWrite, true, "dry-run would write when not already held");
  assertEqual(dryRun.currentStatus, null, "dry-run skips current status read");
  assertEqual(dryRun.currentHoldValue, null, "dry-run skips current hold read");
  assertEqual((dryRun as { stateReadSkipped?: boolean }).stateReadSkipped, true, "dry-run reports state read skipped");
  JSON.stringify(dryRun);

  const hangingClient = new HangingAcumaticaClient();
  const timedDryRun = await Promise.race([
    processDeliveryPrepaymentHoldJob(
      {
        orderType: "SO",
        orderNumber: "SO38056",
        reason: DELIVERY_PREPAYMENT_HOLD_REASON,
        dryRun: true,
      },
      hangingClient,
      {}
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 100)),
  ]);
  assertEqual(
    (timedDryRun as { status?: string }).status,
    "dry_run",
    "dry-run does not hang on unavailable Acumatica client"
  );
  assertEqual(hangingClient.readCalls, 0, "hanging dry-run does not call Acumatica GET");
  assertEqual(hangingClient.putCalls, 0, "hanging dry-run does not call Acumatica PUT");

  const envDryRunClient = new MockAcumaticaClient([openState]);
  const envDryRun = await processDeliveryPrepaymentHoldJob(
    {
      orderType: "SO",
      orderNumber: "SO38056",
      reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      dryRun: false,
    },
    envDryRunClient,
    { ACUMATICA_PREPAYMENT_HOLD_DRY_RUN: "true", ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED: "true" }
  );
  assertEqual(envDryRun.status, "dry_run", "env dry-run overrides live payload");
  assertEqual(envDryRunClient.putCalls, 0, "env dry-run does not call PUT");
  assertEqual(envDryRunClient.readCalls, 0, "env dry-run does not call GET");

  const disabledClient = new MockAcumaticaClient([openState]);
  const disabled = await processDeliveryPrepaymentHoldJob(
    {
      orderType: "SO",
      orderNumber: "SO38056",
      reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      dryRun: false,
    },
    disabledClient,
    { ACUMATICA_PREPAYMENT_HOLD_DRY_RUN: "false" }
  );
  assertEqual(disabled.status, "refused", "live disabled refuses");
  assertEqual(disabled.reason, "live_write_disabled", "live disabled reason");
  assertEqual(disabledClient.putCalls, 0, "live disabled does not call PUT");
  assertEqual(disabledClient.readCalls, 0, "live disabled does not call GET");

  const notExposedClient = new MockAcumaticaClient([holdNotExposedState]);
  const notExposed = await processDeliveryPrepaymentHoldJob(
    {
      orderType: "SO",
      orderNumber: "SO38056",
      reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      dryRun: false,
    },
    notExposedClient,
    {
      ACUMATICA_PREPAYMENT_HOLD_DRY_RUN: "false",
      ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED: "true",
      ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER: "SO38056",
    }
  );
  assertEqual(notExposed.status, "failed", "hold field missing fails safely");
  assertEqual(notExposed.reason, "hold_field_not_exposed", "hold field missing reason");
  assertEqual(notExposedClient.putCalls, 0, "hold field missing does not call PUT");

  const allowlistClient = new MockAcumaticaClient([openState]);
  const allowlist = await processDeliveryPrepaymentHoldJob(
    {
      orderType: "SO",
      orderNumber: "SO38056",
      reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      dryRun: false,
    },
    allowlistClient,
    {
      ACUMATICA_PREPAYMENT_HOLD_DRY_RUN: "false",
      ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED: "true",
      ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER: "SO99999",
    }
  );
  assertEqual(allowlist.status, "refused", "allowlist refuses");
  assertEqual(allowlist.reason, "order_not_allowlisted", "allowlist reason");
  assertEqual(allowlist.allowedByOrderAllowlist, false, "allowlist result flag");
  assertEqual(allowlistClient.putCalls, 0, "allowlist does not call PUT");
  assertEqual(allowlistClient.readCalls, 0, "allowlist does not call GET");

  const alreadyClient = new MockAcumaticaClient([heldState]);
  const already = await processDeliveryPrepaymentHoldJob(
    {
      orderType: "SO",
      orderNumber: "SO38056",
      reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      dryRun: false,
    },
    alreadyClient,
    {
      ACUMATICA_PREPAYMENT_HOLD_DRY_RUN: "false",
      ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED: "true",
      ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER: "SO38056",
    }
  );
  assertEqual(already.status, "already_on_hold", "already-on-hold status");
  assertEqual(alreadyClient.putCalls, 0, "already-on-hold does not call PUT again");

  const successClient = new MockAcumaticaClient([openState], [heldState]);
  const success = await processDeliveryPrepaymentHoldJob(
    {
      orderType: "SO",
      orderNumber: "SO38056",
      reason: DELIVERY_PREPAYMENT_HOLD_REASON,
      dryRun: false,
    },
    successClient,
    {
      ACUMATICA_PREPAYMENT_HOLD_DRY_RUN: "false",
      ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED: "true",
      ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER: "SO38056",
    }
  );
  assertEqual(success.status, "succeeded", "successful mocked write");
  assertEqual(successClient.putCalls, 1, "successful mocked write calls PUT once");
  const successVerification = (
    success as { verification?: { holdBefore: boolean | null; statusAfter: string | null } }
  ).verification;
  assertEqual(successVerification?.holdBefore, false, "verification holdBefore");
  assertEqual(successVerification?.statusAfter, "On Hold", "verification statusAfter");

  console.log(
    JSON.stringify(
      {
        jobTypeWired: true,
        routeValidatesPayload: true,
        blankOrderTypeRejected: true,
        blankOrderNumberRejected: true,
        invalidReasonRejected: true,
        dryRunDoesNotPut: true,
        dryRunDoesNotGet: true,
        dryRunDoesNotHangOnUnavailableAcumaticaClient: true,
        dryRunResultIsSerializable: true,
        resultPersistenceWired: true,
        failurePersistenceWired: true,
        liveWriteDisabledRefuses: true,
        holdFieldNotExposedFailsSafely: true,
        allowlistBlocksNonAllowedOrder: true,
        alreadyOnHoldIsIdempotentSuccess: true,
        plannedPayloadIsMinimalHoldTrue: true,
        resultShapeIncludesSafetyFields: true,
        noHoldFalsePath: true,
        noLiveAcumaticaWritePerformed: true,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
