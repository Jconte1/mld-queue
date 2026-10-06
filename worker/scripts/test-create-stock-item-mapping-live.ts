import "dotenv/config";

import { AcumaticaClient } from "../src/lib/acumaticaClient";
import { processCreateStockItemJob } from "../src/lib/createStockItem";
import { prisma } from "../src/lib/prisma";

const CONFIRMATION = "CREATE_ONE_MAPPED_STOCK_ITEM";

function fieldValue(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

function rows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") return [payload as Record<string, unknown>];
  return [];
}

async function main(): Promise<void> {
  if (process.env.CREATE_STOCK_ITEM_MAPPING_LIVE_CONFIRM !== CONFIRMATION) {
    throw new Error(
      `Refusing live write. Set CREATE_STOCK_ITEM_MAPPING_LIVE_CONFIRM=${CONFIRMATION}`
    );
  }
  const inventoryId = process.env.CREATE_STOCK_ITEM_MAPPING_LIVE_INVENTORY_ID?.trim().toUpperCase();
  if (!inventoryId || !/^MLD-MAP-TST-[A-Z0-9-]+$/.test(inventoryId)) {
    throw new Error("CREATE_STOCK_ITEM_MAPPING_LIVE_INVENTORY_ID must start with MLD-MAP-TST-");
  }

  const client = new AcumaticaClient();
  try {
    const existing = await client.getStockItemForCleanup(inventoryId);
    if (rows(existing).length) {
      throw new Error(`Refusing live write because StockItem ${inventoryId} already exists`);
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "StockItemNotFoundError") {
      throw error;
    }
  }
  const payload: Record<string, unknown> = {
    manufacturer: "Thermador",
    InventoryID: { value: inventoryId },
    Description: { value: "Manufacturer mapping integration test" },
    MSRP: { value: 1 },
    DefaultPrice: { value: 1 },
    ItemClass: { value: "SHOULD-BE-OVERRIDDEN" },
    PriceClass: { value: "SHOULD-BE-OVERRIDDEN" },
    VendorDetails: [{ VendorID: { value: "SHOULD-BE-OVERRIDDEN" } }],
  };

  const createResult = await processCreateStockItemJob(payload, client, {
    jobId: `manual-live-test-${inventoryId}`,
  });
  const verificationPayload = await client.getStockItemForCleanup(inventoryId);
  const item = rows(verificationPayload)[0];
  if (!item) throw new Error(`Created StockItem ${inventoryId} could not be read back`);
  const vendorDetails = Array.isArray(item.VendorDetails)
    ? (item.VendorDetails as Record<string, unknown>[])
    : [];
  const vendorIds = vendorDetails
    .map((detail) => String(fieldValue(detail.VendorID) ?? "").trim().toUpperCase())
    .filter(Boolean);
  const actual = {
    inventoryId: String(fieldValue(item.InventoryID) ?? "").trim().toUpperCase(),
    itemClass: String(fieldValue(item.ItemClass) ?? "").trim().toUpperCase(),
    priceClass: String(fieldValue(item.PriceClass) ?? "").trim().toUpperCase(),
    vendorIds,
  };
  if (
    actual.inventoryId !== inventoryId ||
    actual.itemClass !== "APLS-RCVD" ||
    actual.priceClass !== "A007" ||
    !actual.vendorIds.includes("BA0000001")
  ) {
    throw new Error(`Live verification failed: ${JSON.stringify(actual)}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        writePerformed: true,
        inventoryId,
        expected: {
          manufacturer: "Thermador",
          itemClass: "APLS-RCVD",
          priceClass: "A007",
          vendorId: "BA0000001",
        },
        actual,
        createResult,
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
