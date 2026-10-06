import { log } from "./logger";
import { normalizeManufacturerKey } from "./manufacturerMapping";
import { prisma } from "./prisma";

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
  createStockItem(payload: Record<string, unknown>): Promise<unknown>;
};

export type CreateStockItemDependencies = {
  findMapping?: (manufacturerKey: string) => Promise<StockItemMapping | null>;
  jobId?: string;
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
    super(`Approved manufacturer mapping for '${manufacturer}' is missing a VendorID`);
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
  return prisma.manufacturerMapping.findUnique({
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
  const manufacturer = manufacturerFromPayload(payload);
  const manufacturerKey = normalizeManufacturerKey(manufacturer);
  const findMapping = dependencies.findMapping ?? findManufacturerMapping;
  const mapping = await findMapping(manufacturerKey);

  if (!mapping) throw new ManufacturerMappingNotFoundError(manufacturer, manufacturerKey);
  if (mapping.status !== "approved") {
    throw new ManufacturerMappingNotApprovedError(manufacturer, mapping.status);
  }
  if (!mapping.vendorId) throw new ManufacturerMappingIncompleteError(manufacturer);

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
  return writer.createStockItem(acumaticaPayload);
}
