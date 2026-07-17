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

function resultReason(value: unknown) {
  return typeof value === "object" && value !== null && "reason" in value
    ? String((value as { reason?: unknown }).reason)
    : null;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    orderType: "SO",
    orderNumber: "SO37860",
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
    orderNumber: "SO37860",
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
  assertEqual(dryRunResult.orderNumber, "SO37860", "orderNumber normalized");
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

  const wrongOrder = mockClient(currentValues());
  const wrongOrderResult = await processDeliveryConfirmationAttributesJob(
    payload({ orderNumber: "SO99999", dryRun: false }),
    wrongOrder.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
    }
  );
  assertEqual(wrongOrderResult.status, "live_write_refused", "wrong order guard status");
  assertEqual(
    resultReason(wrongOrderResult),
    "order_not_allowed_for_controlled_test",
    "wrong order guard reason"
  );
  assertEqual(wrongOrder.calls.fetch, 0, "wrong order fetch calls");
  assertEqual(wrongOrder.calls.put.length, 0, "wrong order put calls");

  const liveBlank = mockClient(currentValues());
  const liveBlankResult = await processDeliveryConfirmationAttributesJob(
    payload({ dryRun: false }),
    liveBlank.client,
    {
      ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED: "true",
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
    }
  );
  assertEqual(notExposedResult.status, "blocked_fields_not_exposed", "not exposed status");
  assertEqual(notExposed.calls.put.length, 0, "not exposed put calls");

  console.log(
    JSON.stringify(
      {
        dryRun: dryRunResult.status,
        disabledGuard: disabledResult.status,
        wrongOrderGuard: wrongOrderResult.status,
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
