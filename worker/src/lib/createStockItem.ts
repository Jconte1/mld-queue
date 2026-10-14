import { log } from "./logger";
import { normalizeManufacturerKey } from "./manufacturerMapping";
import { prisma } from "./prisma";
import { normalizeStockItemPayloadForRequestedId } from "./acumaticaClient";

export type StockItemMapping = {
  manufacturerKey: string;
  manufacturerName: string;
  priceClass: string;
  itemClass: string;
  purchaseUnit: string;
  vendorId: string | null;
  vendorName: string | null;
  status: "pending" | "approved" | "blocked";
};

export type StockItemWriter = {
  findStockItemForCreation(inventoryId: string): Promise<Record<string, unknown> | null>;
  createStockItem(payload: Record<string, unknown>): Promise<unknown>;
  getStockItemForVerification(inventoryId: string): Promise<unknown>;
};

const inventoryLocks = new Map<string, Promise<void>>();

async function serializeInventory<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = inventoryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  inventoryLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (inventoryLocks.get(key) === current) inventoryLocks.delete(key);
  }
}

export type CreateStockItemDependencies = {
  findMapping?: (manufacturerKey: string) => Promise<StockItemMapping | null>;
  jobId?: string;
  recordUnresolved?: (key: string, name: string, inventoryId: string, jobId?: string) => Promise<void>;
};

export class ManufacturerMappingNotFoundError extends Error {
  constructor(manufacturer: string, manufacturerKey: string) {
    super(`No manufacturer mapping exists for '${manufacturer}' (normalized: '${manufacturerKey}')`);
    this.name = "ManufacturerMappingNotFoundError";
  }
}

export class ManufacturerMappingNotApprovedError extends Error {
  constructor(manufacturer: string, status: string) {
    super(`Manufacturer mapping for '${manufacturer}' is not approved (status: ${status})`);
    this.name = "ManufacturerMappingNotApprovedError";
  }
}

export class ManufacturerMappingIncompleteError extends Error {
  constructor(manufacturer: string) {
    super(`Approved manufacturer mapping for '${manufacturer}' is missing VendorID, ItemClass, PriceClass, or PurchaseUnit`);
    this.name = "ManufacturerMappingIncompleteError";
  }
}

function manufacturerFromPayload(payload: Record<string, unknown>): string {
  if (typeof payload.manufacturer !== "string" || !payload.manufacturer.trim()) {
    throw new Error("manufacturer is required and must be a non-empty string");
  }
  return payload.manufacturer.trim();
}

function inventoryIdFromPayload(payload: Record<string, unknown>): string {
  const inventoryId = payload.InventoryID;
  if (
    inventoryId &&
    typeof inventoryId === "object" &&
    "value" in inventoryId &&
    typeof inventoryId.value === "string"
  ) {
    return inventoryId.value.trim();
  }
  return "";
}

export async function findManufacturerMapping(
  manufacturerKey: string
): Promise<StockItemMapping | null> {
  const canonical = await prisma.manufacturerMapping.findUnique({
    where: { manufacturerKey },
    select: {
      manufacturerKey: true,
      manufacturerName: true,
      priceClass: true,
      itemClass: true,
      purchaseUnit: true,
      vendorId: true,
      vendorName: true,
      status: true,
    },
  });
  if (canonical) return canonical;
  const alias = await prisma.manufacturerAlias.findUnique({
    where: { manufacturerKey }, include: { mapping: true },
  });
  if (alias && alias.status !== "approved") {
    throw new ManufacturerMappingNotApprovedError(alias.suppliedName, alias.status);
  }
  return alias?.mapping ?? null;
}

async function recordUnresolved(key: string, name: string, inventoryId: string, jobId?: string) {
  const context = { suppliedName: name, lastInventoryId: inventoryId, lastJobId: jobId ?? null,
    lastSeenAt: new Date() };
  await prisma.manufacturerAlias.upsert({
    where: { manufacturerKey: key },
    create: { manufacturerKey: key, ...context, seenCount: 1 },
    update: { ...context, seenCount: { increment: 1 } },
  });
}

function value(record: Record<string, unknown>, field: string): unknown {
  const raw = record[field];
  return raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
}

export class StockItemMappingVerificationError extends Error {
  responseBody: unknown;
  constructor(inventoryId: string, diagnostics: unknown) {
    super(`StockItem ${inventoryId} was written but mapping verification failed; inspect Acumatica before retrying`);
    this.name = "StockItemMappingVerificationError";
    this.responseBody = diagnostics;
  }
}

export function buildMappedStockItemPayload(
  payload: Record<string, unknown>,
  mapping: StockItemMapping
): Record<string, unknown> {
  const acumaticaPayload = { ...payload };
  delete acumaticaPayload.manufacturer;

  acumaticaPayload.ItemClass = { value: mapping.itemClass };
  acumaticaPayload.PriceClass = { value: mapping.priceClass };
  acumaticaPayload.VendorDetails = [
    {
      VendorID: { value: mapping.vendorId },
      PurchaseUnit: { value: mapping.purchaseUnit },
    },
  ];
  return acumaticaPayload;
}

export async function processCreateStockItemJob(
  payload: Record<string, unknown>,
  writer: StockItemWriter,
  dependencies: CreateStockItemDependencies = {}
): Promise<unknown> {
  const key = inventoryIdFromPayload(payload).toUpperCase().replace(/_/g, " ");
  if (!key) throw new Error("InventoryID.value is required");
  return serializeInventory(key, () => processMappedStockItem(payload, writer, dependencies));
}

function mappingFields(row: Record<string, unknown>) {
  const details = Array.isArray(row.VendorDetails) ? row.VendorDetails as Record<string, unknown>[] : [];
  return { itemClass: value(row, "ItemClass"), priceClass: value(row, "PriceClass"),
    vendorIds: details.map(detail => value(detail, "VendorID")) };
}

function matchesRequestedFields(row: Record<string, unknown>, requested: Record<string, unknown>): boolean {
  const expectedVendor = (requested.VendorDetails as Record<string, unknown>[])[0];
  const details = Array.isArray(row.VendorDetails) ? row.VendorDetails as Record<string, unknown>[] : [];
  if (!details.some(detail => value(detail, "VendorID") === value(expectedVendor, "VendorID") &&
    value(detail, "PurchaseUnit") === value(expectedVendor, "PurchaseUnit"))) return false;
  for (const [field, expected] of Object.entries(requested)) {
    if (["VendorDetails", "InventoryID", "id"].includes(field)) continue;
    if (!expected || typeof expected !== "object" || !("value" in expected)) return false;
    const actual = value(row, field);
    if (["MSRP", "DefaultPrice"].includes(field)) {
      if (actual == null || Number(actual) !== Number(expected.value)) return false;
    } else if (actual !== expected.value) return false;
  }
  return true;
}

function existingResult(row: Record<string, unknown>, payload: Record<string, unknown>, mapping: StockItemMapping) {
  const normalized = normalizeStockItemPayloadForRequestedId(row, inventoryIdFromPayload(payload)) as Record<string, unknown>;
  return { ...normalized, alreadyExisted: true, mappingVerification: {
    verified: true, suppliedManufacturer: payload.manufacturer,
    manufacturerKey: normalizeManufacturerKey(String(payload.manufacturer)),
    canonicalManufacturer: mapping.manufacturerName,
    expected: { itemClass: mapping.itemClass, priceClass: mapping.priceClass, vendorId: mapping.vendorId },
    actual: mappingFields(row),
  } };
}

async function processMappedStockItem(
  payload: Record<string, unknown>,
  writer: StockItemWriter,
  dependencies: CreateStockItemDependencies = {}
): Promise<unknown> {
  const manufacturer = manufacturerFromPayload(payload);
  if (!inventoryIdFromPayload(payload)) throw new Error("InventoryID.value is required");
  const manufacturerKey = normalizeManufacturerKey(manufacturer);
  const findMapping = dependencies.findMapping ?? findManufacturerMapping;
  const recordReview = dependencies.recordUnresolved ?? recordUnresolved;
  let mapping: StockItemMapping | null;
  try {
    mapping = await findMapping(manufacturerKey);
  } catch (error) {
    if (error instanceof ManufacturerMappingNotApprovedError) {
      await recordReview(manufacturerKey, manufacturer, inventoryIdFromPayload(payload), dependencies.jobId);
      log("warn", "create_stock_item_manufacturer_review_required", {
        jobId: dependencies.jobId ?? null, manufacturer, manufacturerKey,
        inventoryId: inventoryIdFromPayload(payload), reason: error.message,
      });
    }
    throw error;
  }

  if (!mapping || mapping.status !== "approved") {
    await recordReview(manufacturerKey, manufacturer, inventoryIdFromPayload(payload), dependencies.jobId);
    log("warn", "create_stock_item_manufacturer_review_required", {
      jobId: dependencies.jobId ?? null, manufacturer, manufacturerKey,
      inventoryId: inventoryIdFromPayload(payload), status: mapping?.status ?? "unknown",
    });
  }
  if (!mapping) throw new ManufacturerMappingNotFoundError(manufacturer, manufacturerKey);
  if (mapping.status !== "approved") {
    throw new ManufacturerMappingNotApprovedError(manufacturer, mapping.status);
  }
  if (!mapping.vendorId || !mapping.priceClass || !mapping.itemClass || !mapping.purchaseUnit) {
    throw new ManufacturerMappingIncompleteError(manufacturer);
  }

  const acumaticaPayload = buildMappedStockItemPayload(payload, mapping);
  log("info", "create_stock_item_mapping_selected", {
    jobId: dependencies.jobId ?? null,
    inventoryId: inventoryIdFromPayload(payload) || null,
    suppliedManufacturer: manufacturer,
    manufacturerKey,
    canonicalManufacturer: mapping.manufacturerName,
    vendorId: mapping.vendorId,
    vendorName: mapping.vendorName,
    priceClass: mapping.priceClass,
    itemClass: mapping.itemClass,
    purchaseUnit: mapping.purchaseUnit,
  });
  const inventoryId = inventoryIdFromPayload(payload);
  const existing = await writer.findStockItemForCreation(inventoryId);
  if (existing && matchesRequestedFields(existing, acumaticaPayload)) {
    log("info", "create_stock_item_already_correct", {
      jobId: dependencies.jobId ?? null, inventoryId, ...mappingFields(existing),
    });
    return existingResult(existing, payload, mapping);
  }
  const writePayload = { ...acumaticaPayload };
  if (existing) {
    if (existing.id) writePayload.id = existing.id;
    writePayload.InventoryID = existing.InventoryID;
    const vendorRows = Array.isArray(existing.VendorDetails)
      ? existing.VendorDetails as Record<string, unknown>[] : [];
    const vendorRow = vendorRows.find(row => value(row, "VendorID") === mapping.vendorId);
    if (vendorRow && value(vendorRow, "PurchaseUnit") === mapping.purchaseUnit) {
      delete writePayload.VendorDetails;
    } else if (vendorRow) {
      if (!vendorRow.id) throw new Error(`Existing vendor row for ${inventoryId} has no child ID; review before updating`);
      writePayload.VendorDetails = [{ id: vendorRow.id,
        VendorID: { value: mapping.vendorId }, PurchaseUnit: { value: mapping.purchaseUnit } }];
    }
  }
  let result: unknown;
  try {
    result = await writer.createStockItem(writePayload);
  } catch (error) {
    // Another replica or a lost response may have completed this create.
    const recovered = await writer.findStockItemForCreation(inventoryId).catch(() => null);
    if (recovered && matchesRequestedFields(recovered, acumaticaPayload)) {
      log("info", "create_stock_item_recovered_existing", { jobId: dependencies.jobId ?? null, inventoryId });
      return existingResult(recovered, payload, mapping);
    }
    throw error;
  }
  const resultRow = Array.isArray(result) ? result[0] : result;
  const lookupKey = resultRow && typeof resultRow === "object" && "id" in resultRow && resultRow.id
    ? String(resultRow.id) : inventoryIdFromPayload(payload);
  let actual: unknown;
  try {
    const readBack = await writer.getStockItemForVerification(lookupKey);
    const row = (Array.isArray(readBack) ? readBack[0] : readBack) as Record<string, unknown> | null;
    const details = Array.isArray(row?.VendorDetails) ? row.VendorDetails as Record<string, unknown>[] : [];
    actual = { itemClass: row ? value(row, "ItemClass") : null,
      priceClass: row ? value(row, "PriceClass") : null,
      vendorIds: details.map(detail => value(detail, "VendorID")) };
    const fields = actual as { itemClass: unknown; priceClass: unknown; vendorIds: unknown[] };
    if (fields.itemClass !== mapping.itemClass || fields.priceClass !== mapping.priceClass ||
      !fields.vendorIds.includes(mapping.vendorId)) {
      throw new Error("Saved fields differ from approved mapping");
    }
  } catch (error) {
    const diagnostics = { jobId: dependencies.jobId ?? null, manufacturer, manufacturerKey,
      inventoryId: inventoryIdFromPayload(payload), writePerformed: true,
      expected: { itemClass: mapping.itemClass, priceClass: mapping.priceClass, vendorId: mapping.vendorId },
      actual: actual ?? null, cause: error instanceof Error ? error.message : String(error) };
    log("error", "create_stock_item_mapping_verification_failed", diagnostics);
    throw new StockItemMappingVerificationError(inventoryIdFromPayload(payload), diagnostics);
  }
  log("info", "create_stock_item_mapping_verified", {
    jobId: dependencies.jobId ?? null, manufacturerKey, inventoryId: inventoryIdFromPayload(payload),
    ...actual as Record<string, unknown>,
  });
  const mappingVerification = { verified: true, suppliedManufacturer: manufacturer,
    manufacturerKey, canonicalManufacturer: mapping.manufacturerName,
    expected: { itemClass: mapping.itemClass, priceClass: mapping.priceClass, vendorId: mapping.vendorId },
    actual };
  const normalizedResult = normalizeStockItemPayloadForRequestedId(result, inventoryId);
  return normalizedResult && typeof normalizedResult === "object" && !Array.isArray(normalizedResult)
    ? { ...normalizedResult, mappingVerification } : normalizedResult;
}
