import fs from "node:fs";
import path from "node:path";

import {
  buildDeliveryRequestedDateAcumaticaPayload,
  buildDeliveryRequestedDateDryRunResult,
  evaluateDeliveryRequestedDateWritebackLiveGate,
  processDeliveryRequestedDateJob,
  type DeliveryRequestedDateAcumaticaClient,
} from "../src/lib/deliveryRequestedDate";

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
    deliveryConfirmationId: "dc_123",
    deliveryGroupId: "dg_123",
    originalDeliveryDate: "2026-10-07",
    requestedDeliveryDate: "2026-10-14",
    lineNumbers: [1, 3],
    source: "WEBPAGE",
    dryRun: true,
    requestedAt: "2026-08-27T12:00:00.000Z",
    ...overrides,
  };
}

function field(value: unknown) {
  return { value };
}

function orderRow(params: {
  orderType?: string;
  orderNumber?: string;
  lines?: Array<Record<string, unknown>>;
} = {}) {
  return {
    OrderType: field(params.orderType ?? "SO"),
    OrderNbr: field(params.orderNumber ?? "SO40466"),
    Details:
      params.lines ??
      [
        {
          id: "line-1",
          LineNbr: field(1),
          InventoryID: field("ITEM-1"),
          RequestedOn: field("2026-10-07T00:00:00.000Z"),
        },
        {
          id: "line-3",
          LineNbr: field(3),
          InventoryID: field("ITEM-3"),
          RequestedOn: field("2026-10-07"),
        },
        {
          id: "line-8",
          LineNbr: field(8),
          InventoryID: field("OTHER-8"),
          RequestedOn: field("2026-11-01"),
        },
      ],
  };
}

function mockClient(rows: Record<string, unknown>[] | null = [orderRow()]) {
  const calls: { fetch: number; put: Array<Record<string, unknown>> } = { fetch: 0, put: [] };
  const client: DeliveryRequestedDateAcumaticaClient = {
    async fetchDeliverySalesOrderFull() {
      calls.fetch += 1;
      return rows ?? [];
    },
    async putDeliveryRequestedDateLines(writePayload) {
      calls.put.push(writePayload);
      return { status: 200, body: { ok: true } };
    },
  };

  return { client, calls };
}

function projectFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), "..", relativePath), "utf8");
}

async function main() {
  const dryRunClient = mockClient();
  const dryRunResult = await processDeliveryRequestedDateJob(payload(), dryRunClient.client, {});
  assertEqual(dryRunResult.status, "dry_run", "dry-run status");
  assertEqual(dryRunClient.calls.fetch, 0, "dry-run fetch calls");
  assertEqual(dryRunClient.calls.put.length, 0, "dry-run put calls");

  const dryRunShape = buildDeliveryRequestedDateDryRunResult(payload());
  assertEqual(dryRunShape.fields["Details[].RequestedOn"], "2026-10-14T00:00:00.000Z", "dry-run date format");
  assert(
    !Object.prototype.hasOwnProperty.call(dryRunShape.acumaticaPayload, "RequestedOn"),
    "dry-run payload must not update header RequestedOn"
  );

  const disabled = mockClient();
  const disabledResult = await processDeliveryRequestedDateJob(payload({ dryRun: false }), disabled.client, {});
  assertEqual(disabledResult.status, "live_write_refused", "disabled guard status");
  assertEqual(resultReason(disabledResult), "live_writeback_disabled", "disabled guard reason");
  assertEqual(disabled.calls.fetch, 0, "disabled guard fetch calls");
  assertEqual(disabled.calls.put.length, 0, "disabled guard put calls");

  const enabledNoAllowlist = mockClient();
  const enabledNoAllowlistResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    enabledNoAllowlist.client,
    { ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true" }
  );
  assertEqual(enabledNoAllowlistResult.status, "live_write_refused", "enabled without allowlist status");
  assertEqual(
    resultReason(enabledNoAllowlistResult),
    "requested_date_writeback_not_allowlisted",
    "enabled without allowlist reason"
  );
  assertEqual(enabledNoAllowlist.calls.fetch, 0, "enabled without allowlist fetch calls");

  const allowlistMismatch = mockClient();
  const allowlistMismatchResult = await processDeliveryRequestedDateJob(
    payload({ orderNumber: "SO99999", dryRun: false }),
    allowlistMismatch.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_TYPES: "SO",
    }
  );
  assertEqual(allowlistMismatchResult.status, "live_write_refused", "allowlist mismatch status");
  assertEqual(allowlistMismatch.calls.fetch, 0, "allowlist mismatch fetch calls");

  const gate = evaluateDeliveryRequestedDateWritebackLiveGate(
    { orderType: "SO", orderNumber: "SO40466" },
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_NBRS: "SO40466",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_TYPES: "SO",
    }
  );
  assert(gate.allowedByLiveWriteGate, "matching order number and type should pass live gate");

  const allowAll = mockClient();
  const allowAllResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    allowAll.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(allowAllResult.status, "written", "allow-all live write status");
  assertEqual(allowAll.calls.fetch, 1, "allow-all fetch calls");
  assertEqual(allowAll.calls.put.length, 1, "allow-all put calls");
  assertEqual(
    JSON.stringify(allowAll.calls.put[0]),
    JSON.stringify({
      OrderType: { value: "SO" },
      OrderNbr: { value: "SO40466" },
      Details: [
        {
          LineNbr: { value: 1 },
          RequestedOn: { value: "2026-10-14T00:00:00.000Z" },
          id: "line-1",
        },
        {
          LineNbr: { value: 3 },
          RequestedOn: { value: "2026-10-14T00:00:00.000Z" },
          id: "line-3",
        },
      ],
    }),
    "allow-all exact Acumatica payload"
  );
  assert(
    (allowAll.calls.put[0].Details as Array<Record<string, unknown>>).every((line) => typeof line.id === "string"),
    "live write payload must include child detail ids"
  );
  assert(
    !JSON.stringify(allowAll.calls.put[0]).includes("OTHER-8"),
    "write payload must not include unrelated order lines"
  );
  assert(
    !Object.prototype.hasOwnProperty.call(allowAll.calls.put[0], "RequestedOn"),
    "write payload must not include header RequestedOn"
  );

  const explicitPayloadShape = buildDeliveryRequestedDateAcumaticaPayload(payload(), [
    {
      lineNbr: 1,
      id: "line-1",
      requestedOnExposed: true,
      requestedOnRaw: "2026-10-07",
      requestedOnDateKey: "2026-10-07",
      inventoryId: "ITEM-1",
    },
  ]);
  assertEqual(
    (explicitPayloadShape.Details[0] as Record<string, unknown>).id,
    "line-1",
    "explicit payload builder includes detail id"
  );

  const missingLine = mockClient([
    orderRow({ lines: [{ id: "line-1", LineNbr: field(1), RequestedOn: field("2026-10-07") }] }),
  ]);
  const missingLineResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    missingLine.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(missingLineResult.status, "blocked_line_not_found", "missing target line status");
  assertEqual(missingLine.calls.put.length, 0, "missing target line put calls");

  const missingLineId = mockClient([
    orderRow({
      lines: [
        { id: "line-1", LineNbr: field(1), RequestedOn: field("2026-10-07") },
        { LineNbr: field(3), RequestedOn: field("2026-10-07") },
      ],
    }),
  ]);
  const missingLineIdResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    missingLineId.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(
    missingLineIdResult.status,
    "blocked_line_identity_not_exposed",
    "missing target line id status"
  );
  assertEqual(missingLineId.calls.put.length, 0, "missing target line id put calls");

  const missingRequestedOn = mockClient([
    orderRow({
      lines: [
        { id: "line-1", LineNbr: field(1) },
        { id: "line-3", LineNbr: field(3), RequestedOn: field("2026-10-07") },
      ],
    }),
  ]);
  const missingRequestedOnResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    missingRequestedOn.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(missingRequestedOnResult.status, "blocked_requested_on_not_exposed", "RequestedOn not exposed status");
  assertEqual(missingRequestedOn.calls.put.length, 0, "RequestedOn not exposed put calls");

  const stale = mockClient([
    orderRow({
      lines: [
        { id: "line-1", LineNbr: field(1), RequestedOn: field("2026-10-08") },
        { id: "line-3", LineNbr: field(3), RequestedOn: field("2026-10-07") },
      ],
    }),
  ]);
  const staleResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    stale.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(staleResult.status, "blocked_stale_line_requested_on", "stale RequestedOn status");
  assertEqual(stale.calls.put.length, 0, "stale RequestedOn put calls");

  const alreadyApplied = mockClient([
    orderRow({
      lines: [
        { id: "line-1", LineNbr: field(1), RequestedOn: field("2026-10-14") },
        { id: "line-3", LineNbr: field(3), RequestedOn: field("2026-10-14") },
      ],
    }),
  ]);
  const alreadyAppliedResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    alreadyApplied.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(alreadyAppliedResult.status, "skipped_existing_value", "already applied status");
  assertEqual(alreadyApplied.calls.put.length, 0, "already applied put calls");

  const noOrder = mockClient(null);
  const noOrderResult = await processDeliveryRequestedDateJob(
    payload({ dryRun: false }),
    noOrder.client,
    {
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED: "true",
      ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL: "true",
    }
  );
  assertEqual(noOrderResult.status, "blocked_sales_order_not_found", "sales order not found status");

  assert(
    projectFile("prisma/schema.prisma").includes("ERP_UPDATE_DELIVERY_REQUESTED_DATE"),
    "Prisma JobType includes requested-date job"
  );
  assert(
    fs.existsSync(
      path.join(
        process.cwd(),
        "..",
        "prisma",
        "migrations",
        "20260827120000_add_delivery_requested_date_job_type",
        "migration.sql"
      )
    ),
    "requested-date migration exists"
  );
  assert(
    projectFile("worker/src/worker.ts").includes("processDeliveryRequestedDateJob") &&
      projectFile("worker/src/worker.ts").includes("ERP_UPDATE_DELIVERY_REQUESTED_DATE"),
    "worker dispatches requested-date jobs"
  );
  assert(
    projectFile("gateway/src/app/api/erp/jobs/delivery/requested-date/route.ts").includes(
      "ERP_UPDATE_DELIVERY_REQUESTED_DATE"
    ),
    "gateway route enqueues requested-date jobs"
  );

  console.log(
    JSON.stringify(
      {
        dryRun: dryRunResult.status,
        disabledGuard: disabledResult.status,
        enabledLiveWriteWithoutAllowlist: enabledNoAllowlistResult.status,
        allowlistMismatch: allowlistMismatchResult.status,
        allowAllLiveWrite: allowAllResult.status,
        missingTargetLine: missingLineResult.status,
        missingTargetLineId: missingLineIdResult.status,
        requestedOnNotExposed: missingRequestedOnResult.status,
        staleRequestedOn: staleResult.status,
        alreadyApplied: alreadyAppliedResult.status,
        salesOrderNotFound: noOrderResult.status,
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
