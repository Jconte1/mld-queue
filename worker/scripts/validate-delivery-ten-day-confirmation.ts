import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDeliveryTenDayConfirmationAcumaticaPayload,
  normalizeDeliveryTenDayConfirmationPayload,
  processDeliveryTenDayConfirmationJob,
  type DeliveryTenDayConfirmationAcumaticaClient,
  type DeliveryTenDayConfirmationState,
} from "../src/lib/deliveryTenDayConfirmation";

const ROOT = join(process.cwd(), "..");

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function fakeClient(params: {
  states: DeliveryTenDayConfirmationState[];
  verificationStates?: DeliveryTenDayConfirmationState[];
}) {
  const calls = {
    fetch: 0,
    put: 0,
    putPayload: null as Record<string, unknown> | null,
  };
  const client: DeliveryTenDayConfirmationAcumaticaClient = {
    fetchDeliveryTenDayConfirmationStates: async () => {
      calls.fetch += 1;
      return calls.fetch > 1 ? params.verificationStates ?? params.states : params.states;
    },
    putDeliveryTenDayConfirmation: async (payload) => {
      calls.put += 1;
      calls.putPayload = payload;
      return { status: 200, body: payload };
    },
  };

  return { client, calls };
}

function oneWeekState(value: boolean | null, exposed = true): DeliveryTenDayConfirmationState {
  return {
    orderType: "SO",
    orderNumber: "SO123",
    oneWeekConfirmed: value,
    oneWeekConfirmedExposed: exposed,
  };
}

async function main() {
  const failures: string[] = [];

  const payload = normalizeDeliveryTenDayConfirmationPayload({
    orderType: " so ",
    orderNumber: " so123 ",
    dryRun: true,
    deliveryDate: "2026-08-09",
    sourceInterval: "DAY_10",
  });
  assert(payload.orderType === "SO", "orderType is normalized", failures);
  assert(payload.orderNumber === "SO123", "orderNumber is normalized", failures);
  assert(payload.reason === "delivery_group_cleared", "default reason is fixed", failures);

  const acumaticaPayload = buildDeliveryTenDayConfirmationAcumaticaPayload(payload);
  const serializedPayload = JSON.stringify(acumaticaPayload);
  assert(
    serializedPayload.includes("\"AttributeONEWEEKCON\""),
    "Acumatica payload writes AttributeONEWEEKCON",
    failures
  );
  assert(serializedPayload.includes("\"CustomBooleanField\""), "custom boolean type is used", failures);
  assert(serializedPayload.includes("\"value\":true"), "payload writes true", failures);
  assert(!serializedPayload.includes("\"value\":false"), "payload never writes false", failures);

  const dry = fakeClient({ states: [oneWeekState(false)] });
  const dryResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: true },
    dry.client,
    {}
  );
  assert(dryResult.status === "dry_run", "payload dry-run returns dry_run", failures);
  assert(dry.calls.fetch === 0 && dry.calls.put === 0, "dry-run skips Acumatica calls", failures);

  const envDry = fakeClient({ states: [oneWeekState(false)] });
  const envDryResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: false },
    envDry.client,
    { ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN: "true" }
  );
  assert(envDryResult.status === "dry_run", "env dry-run overrides payload", failures);
  assert(envDry.calls.fetch === 0 && envDry.calls.put === 0, "env dry-run skips reads and writes", failures);

  const formerDisabledEnv = fakeClient({
    states: [oneWeekState(false)],
    verificationStates: [oneWeekState(true)],
  });
  const formerDisabledResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: false },
    formerDisabledEnv.client,
    {
      ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN: "false",
      ACUMATICA_TEN_DAY_CONFIRMATION_WRITE_ENABLED: "false",
    }
  );
  assert(
    formerDisabledResult.status === "written",
    "former write-enabled env blocker no longer disables live write",
    failures
  );
  assert(
    formerDisabledEnv.calls.fetch === 2 && formerDisabledEnv.calls.put === 1,
    "former write-enabled env blocker still allows read, put, verify",
    failures
  );

  const formerAllowlistMismatch = fakeClient({
    states: [oneWeekState(false)],
    verificationStates: [oneWeekState(true)],
  });
  const formerAllowlistMismatchResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: false },
    formerAllowlistMismatch.client,
    {
      ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN: "false",
      ACUMATICA_TEN_DAY_CONFIRMATION_WRITE_ENABLED: "true",
      ACUMATICA_TEN_DAY_CONFIRMATION_ALLOWED_ORDER_NUMBER: "SO999",
    }
  );
  assert(
    formerAllowlistMismatchResult.status === "written",
    "former order allowlist env blocker no longer disables live write",
    failures
  );
  assert(
    formerAllowlistMismatch.calls.fetch === 2 && formerAllowlistMismatch.calls.put === 1,
    "former order allowlist env blocker still allows read, put, verify",
    failures
  );

  const already = fakeClient({ states: [oneWeekState(true)] });
  const alreadyResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: false },
    already.client,
    {
      ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN: "false",
    }
  );
  assert(alreadyResult.status === "already_true", "already true skips write", failures);
  assert(already.calls.fetch === 1 && already.calls.put === 0, "already true performs one read and no PUT", failures);

  const missingField = fakeClient({ states: [oneWeekState(null, false)] });
  const missingFieldResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: false },
    missingField.client,
    {
      ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN: "false",
    }
  );
  assert(missingFieldResult.status === "failed", "missing field fails", failures);
  assert(
    missingFieldResult.reason === "one_week_confirmation_field_not_exposed",
    "missing field reason is descriptive",
    failures
  );
  assert(missingField.calls.put === 0, "missing field does not PUT", failures);

  const write = fakeClient({
    states: [oneWeekState(false)],
    verificationStates: [oneWeekState(true)],
  });
  const writeResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: false },
    write.client,
    {
      ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN: "false",
    }
  );
  assert(writeResult.status === "written", "false value writes true and verifies", failures);
  assert(write.calls.fetch === 2 && write.calls.put === 1, "write path reads, puts, verifies", failures);
  assert(!JSON.stringify(write.calls.putPayload).includes("\"value\":false"), "write payload contains no false", failures);

  const verifyFail = fakeClient({
    states: [oneWeekState(false)],
    verificationStates: [oneWeekState(false)],
  });
  const verifyFailResult = await processDeliveryTenDayConfirmationJob(
    { orderType: "SO", orderNumber: "SO123", dryRun: false },
    verifyFail.client,
    {
      ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN: "false",
    }
  );
  assert(verifyFailResult.status === "failed", "verification false fails", failures);
  assert(verifyFailResult.reason === "verification_failed", "verification failure reason", failures);

  const acumaticaClient = read("worker/src/lib/acumaticaClient.ts");
  const worker = read("worker/src/worker.ts");
  const route = read("gateway/src/app/api/erp/jobs/delivery/ten-day-confirmation/route.ts");
  const schema = read("prisma/schema.prisma");

  assert(
    acumaticaClient.includes("Document.AttributeONEWEEKCON"),
    "Acumatica full/read path includes ONEWEEKCON",
    failures
  );
  assert(
    worker.includes("ERP_UPDATE_DELIVERY_TEN_DAY_CONFIRMATION"),
    "worker dispatches the ten-day confirmation job",
    failures
  );
  assert(
    route.includes("ERP_UPDATE_DELIVERY_TEN_DAY_CONFIRMATION"),
    "gateway route enqueues the ten-day confirmation job type",
    failures
  );
  assert(
    schema.includes("ERP_UPDATE_DELIVERY_TEN_DAY_CONFIRMATION"),
    "Prisma JobType includes the ten-day confirmation job",
    failures
  );

  if (failures.length > 0) {
    console.error("Delivery ten-day confirmation writeback validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "Delivery ten-day confirmation writeback validation passed. No Acumatica call, SMS, email, provider dispatch, or deployment was performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
