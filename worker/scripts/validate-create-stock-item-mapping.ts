import "dotenv/config";

import {
  buildMappedStockItemPayload,
  ManufacturerMappingNotApprovedError,
  ManufacturerMappingNotFoundError,
  processCreateStockItemJob,
  type StockItemMapping,
} from "../src/lib/createStockItem";
import { prisma } from "../src/lib/prisma";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Validation failed: ${message}`);
}

function approvedMapping(overrides: Partial<StockItemMapping> = {}): StockItemMapping {
  return {
    manufacturerKey: "THERMADOR",
    manufacturerName: "Thermador",
    priceClass: "A007",
    itemClass: "APLS-RCVD",
    purchaseUnit: "EACH",
    vendorId: "BA0000001",
    vendorName: "BSH Home Appliances",
    status: "approved",
    ...overrides,
  };
}

async function expectReject(
  action: () => Promise<unknown>,
  expectedType: new (...args: never[]) => Error,
  message: string
): Promise<void> {
  try {
    await action();
    throw new Error(`Validation failed: ${message} did not reject`);
  } catch (error) {
    assert(error instanceof expectedType, `${message} rejected with the expected error type`);
  }
}

async function main(): Promise<void> {
  const originalPayload: Record<string, unknown> = {
    manufacturer: "  Thermador  ",
    InventoryID: { value: "MAPPING-DRY-RUN" },
    Description: { value: "Mapping dry run" },
    MSRP: { value: 1 },
    DefaultPrice: { value: 1 },
    ItemClass: { value: "WRONG-CLASS" },
    PriceClass: { value: "WRONG-PRICE" },
    VendorDetails: [{ VendorID: { value: "WRONG-VENDOR" } }],
  };
  const transformed = buildMappedStockItemPayload(originalPayload, approvedMapping());
  assert(transformed.manufacturer === undefined, "manufacturer is removed before Acumatica");
  assert(
    (transformed.ItemClass as { value: string }).value === "APLS-RCVD",
    "mapping overrides ItemClass"
  );
  assert(
    (transformed.PriceClass as { value: string }).value === "A007",
    "mapping overrides PriceClass"
  );
  const transformedVendor = (
    transformed.VendorDetails as Array<{
      VendorID: { value: string };
      PurchaseUnit: { value: string };
    }>
  )[0];
  assert(transformedVendor.VendorID.value === "BA0000001", "mapping overrides VendorID");
  assert(transformedVendor.PurchaseUnit.value === "EACH", "mapping supplies PurchaseUnit");
  assert(originalPayload.manufacturer === "  Thermador  ", "input payload is not mutated");

  let writeCount = 0;
  let capturedPayload: Record<string, unknown> | null = null;
  const writer = {
    async createStockItem(payload: Record<string, unknown>): Promise<unknown> {
      writeCount += 1;
      capturedPayload = payload;
      return { ok: true };
    },
  };
  const result = await processCreateStockItemJob(originalPayload, writer, {
    findMapping: async (key) => {
      assert(key === "THERMADOR", "manufacturer whitespace and case normalize consistently");
      return approvedMapping();
    },
    jobId: "mapping-dry-run",
  });
  assert(writeCount === 1, "approved mapping calls the writer exactly once");
  assert((result as { ok?: boolean }).ok === true, "writer result is returned");
  assert(capturedPayload?.manufacturer === undefined, "writer never receives manufacturer");

  await expectReject(
    () =>
      processCreateStockItemJob(originalPayload, writer, {
        findMapping: async () => null,
      }),
    ManufacturerMappingNotFoundError,
    "unknown manufacturer"
  );
  assert(writeCount === 1, "unknown manufacturer does not call the writer");

  await expectReject(
    () =>
      processCreateStockItemJob(originalPayload, writer, {
        findMapping: async () => approvedMapping({ status: "pending" }),
      }),
    ManufacturerMappingNotApprovedError,
    "pending manufacturer"
  );
  assert(writeCount === 1, "pending manufacturer does not call the writer");

  let databaseWriteCount = 0;
  let databasePayload: Record<string, unknown> | null = null;
  await processCreateStockItemJob(originalPayload, {
    async createStockItem(payload) {
      databaseWriteCount += 1;
      databasePayload = payload;
      return { dryRun: true };
    },
  });
  assert(databaseWriteCount === 1, "real approved database mapping reaches only the fake writer");
  assert(
    (databasePayload?.PriceClass as { value?: string })?.value === "A007",
    "real Thermador database mapping supplies A007"
  );
  assert(
    ((databasePayload?.VendorDetails as Array<{ VendorID: { value?: string } }>)[0]?.VendorID.value) ===
      "BA0000001",
    "real Thermador database mapping supplies BA0000001"
  );

  const pending = await prisma.manufacturerMapping.findFirst({ where: { status: "pending" } });
  assert(Boolean(pending), "database contains a pending mapping for fail-safe validation");
  await expectReject(
    () =>
      processCreateStockItemJob(
        { ...originalPayload, manufacturer: pending!.manufacturerName },
        writer
      ),
    ManufacturerMappingNotApprovedError,
    "real pending database mapping"
  );
  assert(writeCount === 1, "real pending mapping does not call the writer");

  console.log(
    JSON.stringify(
      {
        ok: true,
        tests: 15,
        acumaticaCalls: 0,
        databaseReadsOnly: true,
        verifiedMapping: {
          manufacturer: "Thermador",
          priceClass: "A007",
          itemClass: "APLS-RCVD",
          vendorId: "BA0000001",
        },
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
