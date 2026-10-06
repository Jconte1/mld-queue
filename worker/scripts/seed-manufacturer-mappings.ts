import "dotenv/config";

import { manufacturerPriceClasses } from "../src/data/manufacturerPriceClasses";
import { normalizeManufacturerKey } from "../src/lib/manufacturerMapping";
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  const keys = new Set<string>();
  const priceClasses = new Set<string>();

  for (const row of manufacturerPriceClasses) {
    const manufacturerKey = normalizeManufacturerKey(row.manufacturerName);
    if (!manufacturerKey) throw new Error(`Manufacturer name is empty for ${row.priceClass}`);
    if (keys.has(manufacturerKey)) throw new Error(`Duplicate manufacturer key: ${manufacturerKey}`);
    if (priceClasses.has(row.priceClass)) throw new Error(`Duplicate price class: ${row.priceClass}`);
    keys.add(manufacturerKey);
    priceClasses.add(row.priceClass);
  }

  const vendors = await prisma.vendor.findMany({
    select: { vendorId: true, vendorName: true },
  });
  const vendorsByName = new Map<string, typeof vendors>();
  for (const vendor of vendors) {
    const key = normalizeManufacturerKey(vendor.vendorName);
    const matches = vendorsByName.get(key) ?? [];
    matches.push(vendor);
    vendorsByName.set(key, matches);
  }

  let exactSuggestionCount = 0;
  await prisma.$transaction(
    manufacturerPriceClasses.map((row) => {
      const manufacturerKey = normalizeManufacturerKey(row.manufacturerName);
      const exactMatches = vendorsByName.get(manufacturerKey) ?? [];
      const suggestion = exactMatches.length === 1 ? exactMatches[0] : undefined;
      if (suggestion) exactSuggestionCount += 1;

      return prisma.manufacturerMapping.upsert({
        where: { manufacturerKey },
        create: {
          manufacturerKey,
          manufacturerName: row.manufacturerName,
          priceClass: row.priceClass,
          itemClass: row.itemClass,
          purchaseUnit: "EACH",
          suggestedVendorId: suggestion?.vendorId,
          suggestedVendorName: suggestion?.vendorName,
          matchSource: suggestion ? "exact_normalized_vendor_name" : null,
        },
        update: {
          manufacturerName: row.manufacturerName,
          priceClass: row.priceClass,
          itemClass: row.itemClass,
          purchaseUnit: "EACH",
          suggestedVendorId: suggestion?.vendorId ?? null,
          suggestedVendorName: suggestion?.vendorName ?? null,
          matchSource: suggestion ? "exact_normalized_vendor_name" : null,
        },
      });
    })
  );

  const counts = await prisma.manufacturerMapping.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  console.log(
    JSON.stringify(
      {
        seededCount: manufacturerPriceClasses.length,
        exactSuggestionCount,
        statusCounts: counts,
        ignoredPriceClasses: ["A114", "BH001", "SWC1"],
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
