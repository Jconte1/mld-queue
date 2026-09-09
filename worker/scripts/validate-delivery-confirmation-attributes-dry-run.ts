import {
  buildDeliveryConfirmationAttributesDryRunResult,
  processDeliveryConfirmationAttributesJob,
  type DeliveryConfirmationAttributesAcumaticaClient,
  type DeliveryConfirmationAttributesCurrentValues,
} from "../src/lib/deliveryConfirmationAttributes";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    orderType: "SO",
    orderNumber: "SO40466",
    confirmedVia: "WEBPAGE",
    confirmedWith: "Trae Customer",
    deliveryConfirmationId: "dc_123",
    deliveryGroupId: "dg_123",
    deliveryDate: "2026-07-22",
    source: "WEBPAGE",
    dryRun: true,
    ...overrides,
  };
}

function currentValues(params: {
  confirmedVia?: string | null;
  confirmedWith?: string | null;
  viaExposed?: boolean;
  withExposed?: boolean;
} = {}): DeliveryConfirmationAttributesCurrentValues {
  return {
    orderType: "SO",
    orderNumber: "SO40466",
    confirmedVia: {
      exposed: params.viaExposed ?? true,
      value: params.confirmedVia ?? null,
    },
    confirmedWith: {
      exposed: params.withExposed ?? true,
      value: params.confirmedWith ?? null,
    },
  };
}

function mockClient(current: DeliveryConfirmationAttributesCurrentValues | null) {
  const calls: { fetch: number; put: Array<Record<string, unknown>> } = { fetch: 0, put: [] };
  const client: DeliveryConfirmationAttributesAcumaticaClient = {
    async fetchDeliveryConfirmationAttributes() {
      calls.fetch += 1;
      return current;
    },
    async putDeliveryConfirmationAttributes(writePayload) {
      calls.put.push(writePayload);
      return { status: 200, body: { ok: true } };
    },
  };

  return { client, calls };
}

async function main() {
  const dryRunResult = buildDeliveryConfirmationAttributesDryRunResult(payload());
  assertEqual(dryRunResult.status, "dry_run", "dryRun status");
  assertEqual(dryRunResult.wouldWrite, true, "dryRun wouldWrite");
  assertEqual(dryRunResult.dryRun, true, "dryRun");
  assertEqual(dryRunResult.skippedLiveWrite, true, "dryRun skippedLiveWrite");
  assertEqual(dryRunResult.orderType, "SO", "orderType normalized");
  assertEqual(dryRunResult.orderNumber, "SO40466", "orderNumber normalized");
  assertEqual(dryRunResult.fields["Document.AttributeCONFIRMVIA"], "WEBPAGE", "CONFIRMVIA value");
  assertEqual(
    dryRunResult.fields["Document.AttributeCONFIRMWTH"],
    "Trae Customer",
    "CONFIRMWTH value"
  );

  const formerDisabledEnv = mockClient(currentValues());
  const formerDisabledResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    formerDisabledEnv.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "false",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL: "false",
    }
  );
  assertEqual(
    formerDisabledResult.status,
    "written",
    "former confirmation env blockers no longer disable live write status"
  );
  assertEqual(
    formerDisabledEnv.calls.fetch,
    1,
    "former confirmation env blockers no longer disable fetch calls"
  );
  assertEqual(
    formerDisabledEnv.calls.put.length,
    1,
    "former confirmation env blockers no longer disable put calls"
  );

  const defaultLive = mockClient(currentValues());
  const defaultLiveResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderNumber: "SO99999", dryRun: false }),
    defaultLive.client,
    {}
  );
  assertEqual(defaultLiveResult.status, "written", "missing env defaults to live write status");
  assertEqual(defaultLive.calls.fetch, 1, "missing env defaults to live write fetch calls");
  assertEqual(defaultLive.calls.put.length, 1, "missing env defaults to live write put calls");

  const formerAllowlistMismatch = mockClient(currentValues());
  const formerAllowlistMismatchResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderType: "SO", orderNumber: "SO99999", dryRun: false }),
    formerAllowlistMismatch.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_TYPES: "SO",
    }
  );
  assertEqual(
    formerAllowlistMismatchResult.status,
    "written",
    "former allowlist mismatch no longer blocks confirmation write"
  );
  assertEqual(formerAllowlistMismatch.calls.fetch, 1, "former allowlist mismatch fetch calls");
  assertEqual(formerAllowlistMismatch.calls.put.length, 1, "former allowlist mismatch put calls");

  const liveBlank = mockClient(currentValues());
  const liveBlankResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    liveBlank.client,
    {}
  );
  assertEqual(liveBlankResult.status, "written", "blank-only write status");
  assertEqual(liveBlankResult.dryRun, false, "blank-only dryRun");
  assertEqual(liveBlank.calls.fetch, 1, "blank-only fetch calls");
  assertEqual(liveBlank.calls.put.length, 1, "blank-only put calls");

  const liveExisting = mockClient(
    currentValues({ confirmedVia: "WEBPAGE", confirmedWith: "Existing User" })
  );
  const liveExistingResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    liveExisting.client,
    {}
  );
  assertEqual(liveExistingResult.status, "skipped_existing_value", "existing value status");
  assertEqual(liveExisting.calls.fetch, 1, "existing value fetch calls");
  assertEqual(liveExisting.calls.put.length, 0, "existing value put calls");

  const partial = mockClient(currentValues({ confirmedVia: "WEBPAGE", confirmedWith: null }));
  const partialResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    partial.client,
    {}
  );
  assertEqual(partialResult.status, "written", "partial blank write status");
  assertEqual(partial.calls.put.length, 1, "partial blank put calls");
  assert(
    JSON.stringify(partial.calls.put[0]).includes("AttributeCONFIRMWTH"),
    "partial write should include blank CONFIRMWTH"
  );
  assert(
    !JSON.stringify(partial.calls.put[0]).includes("AttributeCONFIRMVIA"),
    "partial write should not overwrite populated CONFIRMVIA"
  );

  const notExposed = mockClient(currentValues({ viaExposed: false, withExposed: true }));
  const notExposedResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    notExposed.client,
    {}
  );
  assertEqual(notExposedResult.status, "blocked_fields_not_exposed", "not exposed status");
  assertEqual(notExposed.calls.put.length, 0, "not exposed put calls");

  console.log(
    JSON.stringify(
      {
        dryRun: dryRunResult.status,
        formerDisabledEnvNoLongerBlocks: formerDisabledResult.status,
        missingEnvDefaultsToLiveWrite: defaultLiveResult.status,
        formerAllowlistMismatchNoLongerBlocks: formerAllowlistMismatchResult.status,
        blankOnlyWrite: liveBlankResult.status,
        partialBlankWrite: partialResult.status,
        existingValueNoOverwrite: liveExistingResult.status,
        fieldsNotExposed: notExposedResult.status,
        acumaticaPutCallsDuringValidation: 0,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
