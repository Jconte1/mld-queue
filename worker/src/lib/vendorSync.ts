import { prisma } from "./prisma";
import type {
  AcumaticaActiveVendor,
  AcumaticaClient,
  AcumaticaVendorClass,
} from "./acumaticaClient";

export type ActiveVendorSyncResult = {
  activeVendorCount: number;
  vendorClassCount: number;
  excludedVendorClasses: string[];
  replacedVendorCount: number;
  insertedVendorCount: number;
  syncedAt: string;
  durationMs: number;
};

export const EXCLUDED_STOCK_ITEM_VENDOR_CLASSES = ["EXP", "CUSTREF"] as const;

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function validateVendors(vendors: AcumaticaActiveVendor[]): void {
  if (!vendors.length) {
    throw new Error("Acumatica returned zero active vendors; refusing to replace the vendor table");
  }

  const invalid = vendors.filter(
    (vendor) =>
      !vendor.vendorId ||
      !vendor.vendorName ||
      !vendor.vendorClass ||
      vendor.status.toLowerCase() !== "active"
  );
  if (invalid.length) {
    throw new Error(`Acumatica returned ${invalid.length} invalid active vendor record(s)`);
  }

  const excludedClasses = new Set<string>(EXCLUDED_STOCK_ITEM_VENDOR_CLASSES);
  const excluded = vendors.filter((vendor) => excludedClasses.has(vendor.vendorClass.toUpperCase()));
  if (excluded.length) {
    throw new Error(
      `Acumatica returned ${excluded.length} vendor record(s) from excluded class(es): ${[
        ...new Set(excluded.map((vendor) => vendor.vendorClass)),
      ].join(", ")}`
    );
  }

  const duplicates = duplicateValues(vendors.map((vendor) => vendor.vendorId));
  if (duplicates.length) {
    throw new Error(`Acumatica returned duplicate VendorID values: ${duplicates.join(", ")}`);
  }
}

function classDescriptionMap(classes: AcumaticaVendorClass[]): Map<string, string> {
  const invalid = classes.filter((vendorClass) => !vendorClass.classId || !vendorClass.description);
  if (invalid.length) {
    throw new Error(`Acumatica returned ${invalid.length} invalid vendor class record(s)`);
  }

  const duplicates = duplicateValues(classes.map((vendorClass) => vendorClass.classId));
  if (duplicates.length) {
    throw new Error(`Acumatica returned duplicate vendor classes: ${duplicates.join(", ")}`);
  }

  return new Map(classes.map((vendorClass) => [vendorClass.classId, vendorClass.description]));
}

export async function syncActiveVendors(
  acumaticaClient: AcumaticaClient
): Promise<ActiveVendorSyncResult> {
  const startedAt = Date.now();
  const vendors = await acumaticaClient.getActiveVendors(EXCLUDED_STOCK_ITEM_VENDOR_CLASSES);
  const vendorClasses = await acumaticaClient.getVendorClasses();

  validateVendors(vendors);
  const descriptions = classDescriptionMap(vendorClasses);
  const unmappedClasses = [...new Set(
    vendors
      .filter((vendor) => !descriptions.has(vendor.vendorClass))
      .map((vendor) => vendor.vendorClass)
  )].sort();
  if (unmappedClasses.length) {
    throw new Error(`No description found for vendor class(es): ${unmappedClasses.join(", ")}`);
  }

  const syncedAt = new Date();
  const rows = vendors.map((vendor) => ({
    vendorId: vendor.vendorId,
    vendorName: vendor.vendorName,
    vendorClass: vendor.vendorClass,
    vendorClassDescription: descriptions.get(vendor.vendorClass) as string,
    syncedAt,
  }));

  const databaseResult = await prisma.$transaction(
    async (tx) => {
      const replacedVendorCount = await tx.vendor.count();
      await tx.vendor.deleteMany();
      const inserted = await tx.vendor.createMany({ data: rows });
      return { replacedVendorCount, insertedVendorCount: inserted.count };
    },
    { timeout: 30_000 }
  );

  return {
    activeVendorCount: vendors.length,
    vendorClassCount: vendorClasses.length,
    excludedVendorClasses: [...EXCLUDED_STOCK_ITEM_VENDOR_CLASSES],
    ...databaseResult,
    syncedAt: syncedAt.toISOString(),
    durationMs: Date.now() - startedAt,
  };
}
