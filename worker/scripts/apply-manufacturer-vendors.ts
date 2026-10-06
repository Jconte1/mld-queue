import "dotenv/config";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { vendorClassMatchesItemClass } from "../src/lib/manufacturerMapping";
import { prisma } from "../src/lib/prisma";

type ReviewRow = {
  Manufacturer: string;
  ManufacturerKey: string;
  PriceClass: string;
  ItemClass: string;
  CandidateVendorID: string;
  CandidateVendorName: string;
  CandidateVendorClass: string;
  CandidateActive: boolean;
  CandidateCount: number;
  CandidateShare: string;
  Classification: string;
};

const APPLY = process.env.MANUFACTURER_VENDOR_APPLY?.trim().toLowerCase() === "true";
const REQUIRED_CLASSIFICATION = "STRONG_HISTORY";
const APPROVAL_MODE =
  process.env.MANUFACTURER_VENDOR_APPROVAL_MODE?.trim() || "strong-history";

function requiredPath(): string {
  const value = process.env.MANUFACTURER_VENDOR_REVIEW_PATH?.trim();
  if (!value) throw new Error("MANUFACTURER_VENDOR_REVIEW_PATH is required");
  return path.resolve(value);
}

async function main(): Promise<void> {
  const reviewPath = requiredPath();
  const rows = JSON.parse(await readFile(reviewPath, "utf8")) as ReviewRow[];
  const approvedCandidates = rows.filter((row) =>
    APPROVAL_MODE === "reviewed-candidates"
      ? Boolean(row.CandidateVendorID) && row.CandidateActive
      : row.Classification === REQUIRED_CLASSIFICATION
  );
  if (!approvedCandidates.length) {
    throw new Error(`No candidates found for approval mode ${APPROVAL_MODE} in ${reviewPath}`);
  }

  const duplicateKeys = approvedCandidates.filter(
    (row, index, all) =>
      all.findIndex((candidate) => candidate.ManufacturerKey === row.ManufacturerKey) !== index
  );
  if (duplicateKeys.length) {
    throw new Error(
      `Duplicate manufacturer keys in review report: ${[
        ...new Set(duplicateKeys.map((row) => row.ManufacturerKey)),
      ].join(", ")}`
    );
  }

  const vendorIds = [...new Set(approvedCandidates.map((row) => row.CandidateVendorID))];
  const [vendors, mappings] = await Promise.all([
    prisma.vendor.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { vendorId: true, vendorName: true, vendorClass: true },
    }),
    prisma.manufacturerMapping.findMany({
      where: { manufacturerKey: { in: approvedCandidates.map((row) => row.ManufacturerKey) } },
      select: {
        manufacturerKey: true,
        manufacturerName: true,
        priceClass: true,
        itemClass: true,
        status: true,
        vendorId: true,
      },
    }),
  ]);
  const vendorsById = new Map(vendors.map((vendor) => [vendor.vendorId, vendor]));
  const mappingsByKey = new Map(
    mappings.map((mapping) => [mapping.manufacturerKey, mapping])
  );

  const errors: string[] = [];
  for (const row of approvedCandidates) {
    const mapping = mappingsByKey.get(row.ManufacturerKey);
    const vendor = vendorsById.get(row.CandidateVendorID);
    const share = Number(row.CandidateShare);
    if (!mapping) errors.push(`${row.ManufacturerKey}: mapping no longer exists`);
    if (!vendor) errors.push(`${row.ManufacturerKey}: vendor ${row.CandidateVendorID} is not active`);
    if (mapping && (mapping.priceClass !== row.PriceClass || mapping.itemClass !== row.ItemClass)) {
      errors.push(`${row.ManufacturerKey}: mapping fields changed after the audit`);
    }
    if (!row.CandidateActive) errors.push(`${row.ManufacturerKey}: report marks candidate inactive`);
    if (
      APPROVAL_MODE === "strong-history" &&
      (row.CandidateCount < 3 || !Number.isFinite(share) || share < 0.95)
    ) {
      errors.push(`${row.ManufacturerKey}: evidence no longer meets the strong threshold`);
    }
    if (
      APPROVAL_MODE === "strong-history" &&
      vendor &&
      !vendorClassMatchesItemClass(vendor.vendorClass, row.ItemClass)
    ) {
      errors.push(
        `${row.ManufacturerKey}: vendor class ${vendor.vendorClass} does not match ${row.ItemClass}`
      );
    }
  }
  if (errors.length) {
    throw new Error(`Refusing to apply review report:\n${errors.join("\n")}`);
  }

  const alreadyApprovedSame = approvedCandidates.filter((row) => {
    const mapping = mappingsByKey.get(row.ManufacturerKey);
    return mapping?.status === "approved" && mapping.vendorId === row.CandidateVendorID;
  });
  const updates = approvedCandidates.filter(
    (row) => !alreadyApprovedSame.some((approved) => approved.ManufacturerKey === row.ManufacturerKey)
  );

  if (APPLY && updates.length) {
    await prisma.$transaction(
      updates.map((row) => {
        const vendor = vendorsById.get(row.CandidateVendorID)!;
        return prisma.manufacturerMapping.update({
          where: { manufacturerKey: row.ManufacturerKey },
          data: {
            vendorId: vendor.vendorId,
            vendorName: vendor.vendorName,
            status: "approved",
            matchSource:
              APPROVAL_MODE === "reviewed-candidates"
                ? "user_reviewed_candidate"
                : "historical_price_class_strong",
          },
        });
      })
    );
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        approvalMode: APPROVAL_MODE,
        reviewPath,
        requiredClassification:
          APPROVAL_MODE === "strong-history" ? REQUIRED_CLASSIFICATION : null,
        validatedCandidateCount: approvedCandidates.length,
        alreadyApprovedSameCount: alreadyApprovedSame.length,
        updatedCount: APPLY ? updates.length : 0,
        wouldUpdateCount: APPLY ? 0 : updates.length,
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
