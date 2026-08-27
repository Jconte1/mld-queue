import {
  buildDeliveryConfirmationAttributesDryRunResult,
  evaluateDeliveryConfirmationWritebackLiveGate,
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

function resultReason(value: unknown) {
  return typeof value === "object" && value !== null && "reason" in value
    ? String((value as { reason?: unknown }).reason)
    : null;
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

  const disabled = mockClient(currentValues());
  const disabledResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    disabled.client,
    {}
  );
  assertEqual(disabledResult.status, "live_write_refused", "disabled guard status");
  assertEqual(resultReason(disabledResult), "live_writeback_disabled", "disabled guard reason");
  assertEqual(disabled.calls.fetch, 0, "disabled guard fetch calls");
  assertEqual(disabled.calls.put.length, 0, "disabled guard put calls");

  const anyOrder = mockClient(currentValues());
  const anyOrderResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderNumber: "SO99999", dryRun: false }),
    anyOrder.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
    }
  );
  assertEqual(anyOrderResult.status, "live_write_refused", "enabled live write without allowlist status");
  assertEqual(
    resultReason(anyOrderResult),
    "confirmation_writeback_not_allowlisted",
    "enabled live write without allowlist reason"
  );
  assertEqual(anyOrder.calls.fetch, 0, "enabled live write without allowlist fetch calls");
  assertEqual(anyOrder.calls.put.length, 0, "enabled live write without allowlist put calls");

  const allowAll = mockClient(currentValues());
  const allowAllResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderNumber: "SO99999", dryRun: false }),
    allowAll.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(allowAllResult.status, "written", "allow-all live write status");
  assertEqual(allowAll.calls.fetch, 1, "allow-all live write fetch calls");
  assertEqual(allowAll.calls.put.length, 1, "allow-all live write put calls");

  const allowlistedOrder = mockClient(currentValues());
  const allowlistedOrderResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderNumber: "SO40466", dryRun: false }),
    allowlistedOrder.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466, SO40467",
    }
  );
  assertEqual(allowlistedOrderResult.status, "written", "order-number allowlist live write status");
  assertEqual(allowlistedOrder.calls.fetch, 1, "order-number allowlist fetch calls");
  assertEqual(allowlistedOrder.calls.put.length, 1, "order-number allowlist put calls");

  const allowlistedType = mockClient(currentValues());
  const allowlistedTypeResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderType: "SO", orderNumber: "SO40468", dryRun: false }),
    allowlistedType.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_TYPES: "SO",
    }
  );
  assertEqual(allowlistedTypeResult.status, "written", "order-type allowlist live write status");
  assertEqual(allowlistedType.calls.fetch, 1, "order-type allowlist fetch calls");
  assertEqual(allowlistedType.calls.put.length, 1, "order-type allowlist put calls");

  const allowlistMismatch = mockClient(currentValues());
  const allowlistMismatchResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderType: "SO", orderNumber: "SO99999", dryRun: false }),
    allowlistMismatch.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_TYPES: "SO",
    }
  );
  assertEqual(allowlistMismatchResult.status, "live_write_refused", "allowlist mismatch status");
  assertEqual(resultReason(allowlistMismatchResult), "confirmation_writeback_not_allowlisted", "allowlist mismatch reason");
  assertEqual(allowlistMismatch.calls.fetch, 0, "allowlist mismatch fetch calls");
  assertEqual(allowlistMismatch.calls.put.length, 0, "allowlist mismatch put calls");

  const gate = evaluateDeliveryConfirmationWritebackLiveGate(
    { orderType: "SO", orderNumber: "SO40466" },
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_TYPES: "SO",
    }
  );
  assert(gate.allowedByLiveWriteGate, "matching order number and type should pass live gate");

  const liveBlank = mockClient(currentValues());
  const liveBlankResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    liveBlank.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
    }
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
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
    }
  );
  assertEqual(liveExistingResult.status, "skipped_existing_value", "existing value status");
  assertEqual(liveExisting.calls.fetch, 1, "existing value fetch calls");
  assertEqual(liveExisting.calls.put.length, 0, "existing value put calls");

  const partial = mockClient(currentValues({ confirmedVia: "WEBPAGE", confirmedWith: null }));
  const partialResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    partial.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
    }
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
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
      ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
    }
  );
  assertEqual(notExposedResult.status, "blocked_fields_not_exposed", "not exposed status");
  assertEqual(notExposed.calls.put.length, 0, "not exposed put calls");

  console.log(
    JSON.stringify(
      {
        dryRun: dryRunResult.status,
        disabledGuard: disabledResult.status,
        enabledLiveWriteWithoutAllowlist: anyOrderResult.status,
        allowAllLiveWrite: allowAllResult.status,
        orderNumberAllowlistLiveWrite: allowlistedOrderResult.status,
        orderTypeAllowlistLiveWrite: allowlistedTypeResult.status,
        allowlistMismatch: allowlistMismatchResult.status,
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
