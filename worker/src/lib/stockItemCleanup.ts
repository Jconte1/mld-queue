import { Prisma } from "../../../prisma/generated/client";
import { prisma } from "./prisma";
import { isTransientError } from "./acumaticaClient";

type EnvSource = Record<string, string | undefined>;

type StockItemCleanupAcumaticaClient = {
  getStockItemForCleanup(inventoryId: string): Promise<unknown>;
  getVendor(vendorId: string): Promise<unknown>;
  putStockItemForCleanup(payload: Record<string, unknown>): Promise<{
    status: number;
    body: unknown;
  }>;
};

type CleanupRun = {
  id: string;
  dryRun: boolean;
  writeMode: boolean;
  maxItems: number;
  delayMs: number;
};

type CleanupItem = {
  id: string;
  runId: string;
  inventoryId: string;
  proposedVendorId: string | null;
  vendorConfidence: string | null;
};

type CleanupItemStatus =
  | "pending"
  | "processing"
  | "dry_run_ready"
  | "updated_successfully"
  | "already_updated"
  | "skipped_qty_on_hand"
  | "skipped_item_class"
  | "skipped_vendor_review"
  | "failed_api_transient"
  | "failed_validation_business_rule"
  | "refused_write";

const MAX_ERROR_CHARS = 12000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envFlagEnabled(envSource: EnvSource, name: string): boolean {
  return envSource[name]?.trim().toLowerCase() === "true";
}

function cleanErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : null;
}

function isFatalRunError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 401 || status === 403) return true;

  const message = cleanErrorMessage(error).toLowerCase();
  return (
    message.includes("token request failed") ||
    message.includes("missing required env var") ||
    message.includes("unauthorized")
  );
}

function isBusinessRuleError(error: unknown): boolean {
  const message = cleanErrorMessage(error).toLowerCase();
  return (
    message.includes("an error occurred during processing of the field") ||
    message.includes("cannot be changed") ||
    message.includes("purchase receipt") ||
    message.includes("business rule") ||
    message.includes("validation")
  );
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function toRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const value = (payload as { value?: unknown }).value;
    if (Array.isArray(value)) return value as Record<string, unknown>[];
    return [payload as Record<string, unknown>];
  }
  return [];
}

function firstRow(payload: unknown): Record<string, unknown> | null {
  return toRows(payload)[0] ?? null;
}

function fieldValue(record: Record<string, unknown> | null, key: string): unknown {
  if (!record) return null;
  const raw = record[key];
  if (raw && typeof raw === "object" && "value" in raw) {
    return (raw as { value?: unknown }).value ?? null;
  }
  return raw ?? null;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = fieldValue(record, key);
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function upper(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase();
}

function detailRows(record: Record<string, unknown> | null, key: string): Record<string, unknown>[] {
  if (!record) return [];
  const value = record[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = fieldValue(record, key);
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function vendorDetailsSummary(stockItem: Record<string, unknown> | null) {
  return detailRows(stockItem, "VendorDetails").map((row) => ({
    vendorId: stringField(row, "VendorID"),
    vendorName: stringField(row, "VendorName"),
    active: fieldValue(row, "Active"),
    default: fieldValue(row, "Default"),
    recordId: fieldValue(row, "RecordID"),
    rowNumber: row.rowNumber ?? null,
  }));
}

function warehouseDetailsSummary(stockItem: Record<string, unknown> | null) {
  const warehouses = detailRows(stockItem, "WarehouseDetails").map((row) => ({
    warehouseId: stringField(row, "WarehouseID"),
    qtyOnHand: numberField(row, "QtyOnHand"),
    status: stringField(row, "Status"),
  }));

  return {
    hasPositiveQtyOnHand: warehouses.some(
      (warehouse) => typeof warehouse.qtyOnHand === "number" && warehouse.qtyOnHand > 0
    ),
    warehouseCount: warehouses.length,
    warehouses,
  };
}

function stockItemSummary(stockItem: Record<string, unknown> | null) {
  return {
    inventoryId: stringField(stockItem, "InventoryID"),
    description: stringField(stockItem, "Description"),
    itemClass: stringField(stockItem, "ItemClass"),
    vendorDetails: vendorDetailsSummary(stockItem),
    warehouseDetails: warehouseDetailsSummary(stockItem).warehouses,
  };
}

function firstVendor(stockItem: Record<string, unknown> | null) {
  const vendors = vendorDetailsSummary(stockItem).filter((vendor) => vendor.vendorId);
  return vendors[0] ?? null;
}

function hasVendor(stockItem: Record<string, unknown> | null, vendorId: string) {
  return vendorDetailsSummary(stockItem).some((vendor) => upper(vendor.vendorId) === upper(vendorId));
}

function deriveItemClass(vendorClass: string): string {
  const normalized = upper(vendorClass);
  if (normalized === "PLUMB") return "PLUMB-LOT";
  if (normalized === "HARD") return "HARD-LOT";
  return "APLS-RCVD";
}

function writeAllowed(runId: string, envSource: EnvSource) {
  const writeEnabled = envFlagEnabled(envSource, "ACUMATICA_STOCK_ITEM_CLEANUP_WRITE_ENABLED");
  const allowedRunId = envSource.ACUMATICA_STOCK_ITEM_CLEANUP_ALLOWED_RUN_ID?.trim() || "";
  return {
    writeEnabled,
    allowedRunId: allowedRunId || null,
    allowedByRunId: !allowedRunId || allowedRunId === runId,
  };
}

function buildStockItemPutPayload(params: {
  inventoryId: string;
  newItemClass: string;
  vendorId: string;
  stockItem: Record<string, unknown>;
}) {
  const payload: Record<string, unknown> = {
    InventoryID: { value: params.inventoryId },
    ItemClass: { value: params.newItemClass },
  };

  if (!hasVendor(params.stockItem, params.vendorId)) {
    payload.VendorDetails = [
      {
        VendorID: { value: params.vendorId },
        Active: { value: true },
        CurrencyID: { value: "USD" },
        Location: { value: "MAIN" },
        PurchaseUnit: { value: "EACH" },
      },
    ];
  }

  return payload;
}

async function withAcumaticaRetry<T>(
  label: string,
  fn: () => Promise<T>,
  delayAfterSuccessMs: number
): Promise<T> {
  const maxAttempts = Math.max(1, Number(process.env.ACUMATICA_STOCK_ITEM_CLEANUP_RETRY_ATTEMPTS ?? 3));
  const baseMs = Math.max(100, Number(process.env.ACUMATICA_STOCK_ITEM_CLEANUP_RETRY_BASE_MS ?? 500));
  const maxMs = Math.max(baseMs, Number(process.env.ACUMATICA_STOCK_ITEM_CLEANUP_RETRY_MAX_MS ?? 5000));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await fn();
      if (delayAfterSuccessMs > 0) {
        await sleep(delayAfterSuccessMs);
      }
      return result;
    } catch (error) {
      if (!isTransientError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1) + jitterMs);
      await sleep(delayMs);
    }
  }

  throw new Error(`Acumatica operation failed without a result: ${label}`);
}

async function markItem(
  itemId: string,
  status: CleanupItemStatus,
  data: Prisma.StockItemCleanupItemUpdateInput = {}
): Promise<void> {
  await prisma.stockItemCleanupItem.update({
    where: { id: itemId },
    data: {
      status,
      completedAt: new Date(),
      ...data,
    },
  });
}

async function processCleanupItem(
  run: CleanupRun,
  item: CleanupItem,
  acumaticaClient: StockItemCleanupAcumaticaClient,
  envSource: EnvSource
): Promise<{ stopRun: boolean; reason?: string }> {
  const claimed = await prisma.stockItemCleanupItem.updateMany({
    where: { id: item.id, status: "pending" },
    data: {
      status: "processing",
      attemptCount: { increment: 1 },
      startedAt: new Date(),
      error: null,
    },
  });

  if (claimed.count === 0) return { stopRun: false };

  await prisma.stockItemCleanupRun.update({
    where: { id: run.id },
    data: { currentItemId: item.inventoryId },
  });

  let failureContext: Prisma.StockItemCleanupItemUpdateInput = {};

  try {
    const stockPayload = await withAcumaticaRetry(
      `StockItem GET ${item.inventoryId}`,
      () => acumaticaClient.getStockItemForCleanup(item.inventoryId),
      run.delayMs
    );
    const stockItem = firstRow(stockPayload);

    if (!stockItem) {
      await markItem(item.id, "failed_validation_business_rule", {
        error: "StockItem not found",
      });
      return { stopRun: false };
    }

    const qtyOnHandSummary = warehouseDetailsSummary(stockItem);
    const oldVendor = firstVendor(stockItem);
    const beforeState = stockItemSummary(stockItem);
    const oldItemClass = upper(stringField(stockItem, "ItemClass"));
    failureContext = {
      oldVendorId: oldVendor?.vendorId || null,
      oldVendorName: oldVendor?.vendorName || null,
      oldItemClass: oldItemClass || null,
      qtyOnHandSummary: toPrismaJson(qtyOnHandSummary),
      beforeState: toPrismaJson(beforeState),
    };

    if (qtyOnHandSummary.hasPositiveQtyOnHand) {
      await markItem(item.id, "skipped_qty_on_hand", {
        ...failureContext,
      });
      return { stopRun: false };
    }

    const vendorId = upper(item.proposedVendorId);
    if (!vendorId || upper(item.vendorConfidence) !== "HIGH") {
      await markItem(item.id, "skipped_vendor_review", {
        oldVendorId: oldVendor?.vendorId || null,
        oldVendorName: oldVendor?.vendorName || null,
        oldItemClass: oldItemClass || null,
        qtyOnHandSummary: toPrismaJson(qtyOnHandSummary),
        beforeState: toPrismaJson(beforeState),
        error: "Vendor was not HIGH-confidence approved",
      });
      return { stopRun: false };
    }

    const vendorPayload = await withAcumaticaRetry(
      `Vendor GET ${vendorId}`,
      () => acumaticaClient.getVendor(vendorId),
      run.delayMs
    );
    const vendor = firstRow(vendorPayload);

    const vendorStatus = stringField(vendor, "Status");
    const vendorClass = upper(stringField(vendor, "VendorClass"));
    const vendorName = stringField(vendor, "VendorName");

    if (!vendor || vendorStatus !== "Active") {
      await markItem(item.id, "skipped_vendor_review", {
        oldVendorId: oldVendor?.vendorId || null,
        oldVendorName: oldVendor?.vendorName || null,
        newVendorId: vendorId,
        newVendorName: vendorName || null,
        vendorClass: vendorClass || null,
        oldItemClass: oldItemClass || null,
        qtyOnHandSummary: toPrismaJson(qtyOnHandSummary),
        beforeState: toPrismaJson(beforeState),
        error: `Vendor is not Active: ${vendorStatus || "not found"}`,
      });
      return { stopRun: false };
    }

    const newItemClass = deriveItemClass(vendorClass);
    const targetVendorAlreadyPresent = hasVendor(stockItem, vendorId);
    const alreadyMatches = targetVendorAlreadyPresent && oldItemClass === newItemClass;

    const commonResult = {
      oldVendorId: oldVendor?.vendorId || null,
      oldVendorName: oldVendor?.vendorName || null,
      newVendorId: vendorId,
      newVendorName: vendorName || null,
      vendorClass,
      oldItemClass: oldItemClass || null,
      newItemClass,
      qtyOnHandSummary: toPrismaJson(qtyOnHandSummary),
      beforeState: toPrismaJson(beforeState),
    };
    failureContext = commonResult;

    if (alreadyMatches) {
      await markItem(item.id, "already_updated", {
        ...commonResult,
        verification: toPrismaJson({
          itemClassMatches: true,
          vendorDetailsContainsVendor: true,
          alreadyMatchedBeforeWrite: true,
        }),
      });
      return { stopRun: false };
    }

    if (run.dryRun || !run.writeMode) {
      await markItem(item.id, "dry_run_ready", {
        ...commonResult,
        verification: toPrismaJson({
          wouldUpdateItemClass: oldItemClass !== newItemClass,
          wouldAddVendorDetails: !targetVendorAlreadyPresent,
        }),
      });
      return { stopRun: false };
    }

    const writeGate = writeAllowed(run.id, envSource);
    if (!writeGate.writeEnabled || !writeGate.allowedByRunId) {
      await markItem(item.id, "refused_write", {
        ...commonResult,
        verification: toPrismaJson(writeGate),
        error: !writeGate.writeEnabled
          ? "ACUMATICA_STOCK_ITEM_CLEANUP_WRITE_ENABLED is not true"
          : "Run ID is not allowed by ACUMATICA_STOCK_ITEM_CLEANUP_ALLOWED_RUN_ID",
      });
      return { stopRun: true, reason: "write_gate_refused" };
    }

    const acumaticaPayload = buildStockItemPutPayload({
      inventoryId: item.inventoryId,
      newItemClass,
      vendorId,
      stockItem,
    });

    const putResult = await withAcumaticaRetry(
      `StockItem PUT ${item.inventoryId}`,
      () => acumaticaClient.putStockItemForCleanup(acumaticaPayload),
      run.delayMs
    );

    const afterPayload = await withAcumaticaRetry(
      `StockItem verification GET ${item.inventoryId}`,
      () => acumaticaClient.getStockItemForCleanup(item.inventoryId),
      run.delayMs
    );
    const after = firstRow(afterPayload);
    const afterState = stockItemSummary(after);
    const itemClassMatches = upper(stringField(after, "ItemClass")) === newItemClass;
    const vendorDetailsContainsVendor = hasVendor(after, vendorId);
    const verification = {
      itemClassMatches,
      vendorDetailsContainsVendor,
      expectedItemClass: newItemClass,
      actualItemClass: stringField(after, "ItemClass") || null,
      expectedVendorId: vendorId,
    };

    if (!itemClassMatches || !vendorDetailsContainsVendor) {
      await markItem(item.id, "failed_validation_business_rule", {
        ...commonResult,
        acumaticaResponse: toPrismaJson({
          status: putResult.status,
          body: putResult.body,
          payload: acumaticaPayload,
        }),
        afterState: toPrismaJson(afterState),
        verification: toPrismaJson(verification),
        error: "Post-update StockItem verification failed",
      });
      return { stopRun: true, reason: "verification_failed" };
    }

    await markItem(item.id, "updated_successfully", {
      ...commonResult,
      acumaticaResponse: toPrismaJson({
        status: putResult.status,
        body: putResult.body,
        payload: acumaticaPayload,
      }),
      afterState: toPrismaJson(afterState),
      verification: toPrismaJson(verification),
    });
    return { stopRun: false };
  } catch (error) {
    const fatal = isFatalRunError(error);
    const transient = isTransientError(error);
    const status =
      !fatal && (isBusinessRuleError(error) || !transient)
        ? "failed_validation_business_rule"
        : "failed_api_transient";

    await markItem(item.id, status, {
      ...failureContext,
      error: cleanErrorMessage(error),
    });

    return {
      stopRun: fatal,
      reason: fatal ? "fatal_acumatica_error" : undefined,
    };
  } finally {
    await prisma.stockItemCleanupRun.update({
      where: { id: run.id },
      data: {
        currentItemId: null,
        lastItemId: item.inventoryId,
      },
    });
  }
}

function runIdFromPayload(payload: Record<string, unknown> | undefined): string {
  const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";
  if (!runId) throw new Error("runId is required");
  return runId;
}

export async function processStockItemCleanupRunJob(
  payload: Record<string, unknown> | undefined,
  acumaticaClient: StockItemCleanupAcumaticaClient,
  envSource: EnvSource = process.env
) {
  const runId = runIdFromPayload(payload);
  const run = await prisma.stockItemCleanupRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      dryRun: true,
      writeMode: true,
      maxItems: true,
      delayMs: true,
      status: true,
    },
  });

  if (!run) throw new Error(`StockItem cleanup run not found: ${runId}`);

  await prisma.stockItemCleanupRun.update({
    where: { id: runId },
    data: {
      status: "processing",
      error: null,
    },
  });

  let stopReason: string | undefined;

  while (true) {
    const targetProgressCount = await prisma.stockItemCleanupItem.count({
      where: {
        runId,
        status: {
          in: run.dryRun
            ? ["dry_run_ready"]
            : ["updated_successfully", "already_updated"],
        },
      },
    });
    if (targetProgressCount >= run.maxItems) break;

    const item = await prisma.stockItemCleanupItem.findFirst({
      where: { runId, status: "pending" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        runId: true,
        inventoryId: true,
        proposedVendorId: true,
        vendorConfidence: true,
      },
    });

    if (!item) break;

    const result = await processCleanupItem(run, item, acumaticaClient, envSource);
    if (result.stopRun) {
      stopReason = result.reason;
      break;
    }
  }

  const [processed, updated, skipped, failed, pending] = await Promise.all([
    prisma.stockItemCleanupItem.count({
      where: {
        runId,
        status: {
          in: [
            "dry_run_ready",
            "updated_successfully",
            "already_updated",
            "skipped_qty_on_hand",
            "skipped_item_class",
            "skipped_vendor_review",
            "failed_api_transient",
            "failed_validation_business_rule",
            "refused_write",
          ],
        },
      },
    }),
    prisma.stockItemCleanupItem.count({ where: { runId, status: "updated_successfully" } }),
    prisma.stockItemCleanupItem.count({
      where: { runId, status: { in: ["skipped_qty_on_hand", "skipped_item_class", "skipped_vendor_review"] } },
    }),
    prisma.stockItemCleanupItem.count({
      where: { runId, status: { in: ["failed_api_transient", "failed_validation_business_rule", "refused_write"] } },
    }),
    prisma.stockItemCleanupItem.count({ where: { runId, status: "pending" } }),
  ]);

  const status = stopReason ? "failed" : "completed";
  await prisma.stockItemCleanupRun.update({
    where: { id: runId },
    data: {
      status,
      error: stopReason ?? null,
      currentItemId: null,
    },
  });

  return {
    runId,
    status,
    dryRun: run.dryRun,
    writeMode: run.writeMode,
    maxItems: run.maxItems,
    processed,
    updated,
    skipped,
    failed,
    pending,
    stopReason: stopReason ?? null,
  };
}
