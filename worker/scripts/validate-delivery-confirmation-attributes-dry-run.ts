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

function mockClient(
  initial: DeliveryConfirmationAttributesCurrentValues | null,
  options: {
    readback?: DeliveryConfirmationAttributesCurrentValues | null;
    readbackError?: Error;
    putError?: Error;
    putStatus?: number;
  } = {}
) {
  let current = initial;
  const calls: { fetch: number; put: Array<Record<string, unknown>> } = { fetch: 0, put: [] };
  const client: DeliveryConfirmationAttributesAcumaticaClient = {
    async fetchDeliveryConfirmationAttributes(orderNumber, orderType) {
      assertEqual(orderNumber, "SO40466", "GET order number");
      assertEqual(orderType, "SO", "GET order type");
      calls.fetch += 1;
      if (calls.fetch > 1) {
        if (options.readbackError) throw options.readbackError;
        if ("readback" in options) return options.readback ?? null;
      }
      return current;
    },
    async putDeliveryConfirmationAttributes(writePayload) {
      calls.put.push(writePayload);
      assertEqual(calls.fetch, 1, "GET precedes PUT");
      if (options.putError) throw options.putError;
      const document = (writePayload.custom as {
        Document: Record<string, { value: string }>;
      }).Document;
      if (current) {
        current = {
          ...current,
          confirmedVia: document.AttributeCONFIRMVIA
            ? { exposed: true, value: document.AttributeCONFIRMVIA.value }
            : current.confirmedVia,
          confirmedWith: document.AttributeCONFIRMWTH
            ? { exposed: true, value: document.AttributeCONFIRMWTH.value }
            : current.confirmedWith,
        };
      }
      return { status: options.putStatus ?? 200, body: { ok: true } };
    },
  };

  return { client, calls };
}

async function main() {
  globalThis.fetch = async () => {
    throw new Error("Live network is forbidden during validation");
  };
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
    2,
    "former confirmation env blockers no longer disable fetch calls"
  );
  assertEqual(
    formerDisabledEnv.calls.put.length,
    1,
    "former confirmation env blockers no longer disable put calls"
  );

  const defaultLive = mockClient(currentValues());
  const defaultLiveResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    defaultLive.client,
    {}
  );
  assertEqual(defaultLiveResult.status, "written", "missing env defaults to live write status");
  assertEqual(defaultLive.calls.fetch, 2, "missing env defaults to live write fetch calls");
  assertEqual(defaultLive.calls.put.length, 1, "missing env defaults to live write put calls");

  const formerAllowlistMismatch = mockClient(currentValues());
  const formerAllowlistMismatchResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    formerAllowlistMismatch.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO99999",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_TYPES: "SO",
    }
  );
  assertEqual(
    formerAllowlistMismatchResult.status,
    "written",
    "former allowlist mismatch no longer blocks confirmation write"
  );
  assertEqual(formerAllowlistMismatch.calls.fetch, 2, "former allowlist mismatch fetch calls");
  assertEqual(formerAllowlistMismatch.calls.put.length, 1, "former allowlist mismatch put calls");

  const liveBlank = mockClient(currentValues());
  const liveBlankResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    liveBlank.client,
    {}
  );
  assertEqual(liveBlankResult.status, "written", "blank-only write status");
  assertEqual(liveBlankResult.dryRun, false, "blank-only dryRun");
  assertEqual(liveBlank.calls.fetch, 2, "blank-only fetch calls");
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

  const partial = mockClient(currentValues({ confirmedVia: "PHONE", confirmedWith: null }));
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

  const dry = mockClient(currentValues());
  assertEqual((await processDeliveryConfirmationAttributesJob(payload(), dry.client)).status,
    "dry_run", "processor dry run");
  assertEqual(dry.calls.fetch, 0, "dry run GET calls");
  assertEqual(dry.calls.put.length, 0, "dry run PUT calls");

  const missing = mockClient(null);
  assertEqual((await processDeliveryConfirmationAttributesJob(payload({ dryRun: false }), missing.client)).status,
    "blocked_sales_order_not_found", "missing preflight order");
  assertEqual(missing.calls.put.length, 0, "missing preflight PUT calls");

  const applied = currentValues({ confirmedVia: "WEBPAGE", confirmedWith: "Trae Customer" });
  const failures: Array<{
    label: string;
    initial?: DeliveryConfirmationAttributesCurrentValues;
    options?: Parameters<typeof mockClient>[1];
    error: string;
    puts?: number;
    fetches?: number;
  }> = [
    { label: "unchanged200", options: { readback: currentValues() }, error: "confirmedVia value mismatch" },
    { label: "partial application", options: { readback: currentValues({ confirmedVia: "WEBPAGE" }) }, error: "confirmedWith value mismatch" },
    { label: "wrongorder preflight", initial: { ...applied, orderNumber: "OTHER" }, error: "preflight: sales order identity mismatch", puts: 0, fetches: 1 },
    { label: "wrongorder readback", options: { readback: { ...applied, orderNumber: "OTHER" } }, error: "readback: sales order identity mismatch" },
    { label: "wrong type", options: { readback: { ...applied, orderType: "QT" } }, error: "identity mismatch" },
    { label: "missing identity", initial: { ...applied, orderType: null }, error: "identity mismatch", puts: 0, fetches: 1 },
    { label: "missing readback", options: { readback: null }, error: "readback: sales order not found" },
    { label: "unexposed via", options: { readback: { ...applied, confirmedVia: { exposed: false, value: "WEBPAGE" } } }, error: "confirmedVia not exposed" },
    { label: "unexposed with", options: { readback: { ...applied, confirmedWith: { exposed: false, value: "Trae Customer" } } }, error: "confirmedWith not exposed" },
    { label: "preserved via changed", initial: currentValues({ confirmedVia: "PHONE" }), options: { readback: applied }, error: "confirmedVia value mismatch" },
    { label: "preserved with changed", initial: currentValues({ confirmedWith: "Existing User" }), options: { readback: applied }, error: "confirmedWith value mismatch" },
    { label: "GET failure", options: { readbackError: new Error("GET unavailable") }, error: "GET unavailable" },
    { label: "PUT failure", options: { putError: new Error("PUT unavailable") }, error: "PUT unavailable", fetches: 1 },
    { label: "non-success PUT", options: { putStatus: 500 }, error: "writeback failed: 500", fetches: 1 },
  ];
  for (const test of failures) {
    const mock = mockClient(test.initial ?? currentValues(), test.options);
    let caught: unknown;
    try {
      await processDeliveryConfirmationAttributesJob(payload({ dryRun: false }), mock.client);
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof Error && caught.message.includes(test.error), `${test.label}: expected ${test.error}`);
    assertEqual(mock.calls.put.length, test.puts ?? 1, `${test.label} PUT calls`);
    assertEqual(mock.calls.fetch, test.fetches ?? 2, `${test.label} GET calls`);
  }

  const reversePartial = mockClient(currentValues({ confirmedVia: "  ", confirmedWith: "Existing User" }));
  const reverseResult = await processDeliveryConfirmationAttributesJob(payload({ dryRun: false }), reversePartial.client);
  assertEqual(reverseResult.status, "written", "reverse partial write");
  assert(!JSON.stringify(reversePartial.calls.put[0]).includes("AttributeCONFIRMWTH"), "preserve populated with");
  if (!("readbackValues" in reverseResult)) throw new Error("missing readback evidence");
  assertEqual(reverseResult.readbackValues.confirmedWith.value, "Existing User", "preserved readback evidence");

  // The first PUT applied, but its GET failed. A retry must not PUT again.
  const retryError = Object.assign(new Error("GET timeout"), { status: 503 });
  const retryOptions: { readbackError?: Error } = { readbackError: retryError };
  const retry = mockClient(currentValues(), retryOptions);
  let readError: unknown;
  try {
    await processDeliveryConfirmationAttributesJob(payload({ dryRun: false }), retry.client);
  } catch (error) {
    readError = error;
  }
  assertEqual(readError, retryError, "readback error retains retry metadata");
  delete retryOptions.readbackError;
  const retryResult = await processDeliveryConfirmationAttributesJob(payload({ dryRun: false }), retry.client);
  assertEqual(retryResult.status, "skipped_existing_value", "retry alreadyapplied");
  assertEqual(retry.calls.put.length, 1, "retry does not repeat PUT");

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
        readbackFailureCasesPassed: failures.length,
        retryAlreadyApplied: retryResult.status,
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
