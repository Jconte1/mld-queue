import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { normalizeManufacturerKey } from "../src/lib/manufacturerMapping";
import { processCreateStockItemJob, StockItemMappingVerificationError,
  ManufacturerMappingNotFoundError, type StockItemMapping } from "../src/lib/createStockItem";
import { prisma } from "../src/lib/prisma";
import { isTransientError } from "../src/lib/acumaticaClient";

async function main() {
  const payload = { InventoryID: { value: "MT210EV/EB" },
    Description: { value: "Contemporary Complete Stopper And Strainer Unit Waste Disposer Trim - English Bronze" },
    DefaultPrice: { value: "260.00" }, MSRP: { value: "0.00" },
    manufacturer: "Mountain Plumbing Products" };
  let writes = 0;
  const saved = { id: "mock-item", ItemClass: { value: "PLUMB-LOT" }, PriceClass: { value: "P047" },
    VendorDetails: [{ VendorID: { value: "BA0000739" } }] };
  const writer = {
    async findStockItemForCreation() { return null; },
    async createStockItem(data: Record<string, unknown>) {
      writes++;
      assert.equal(data.manufacturer, undefined);
      assert.deepEqual(data.ItemClass, saved.ItemClass);
      assert.deepEqual(data.PriceClass, saved.PriceClass);
      assert.deepEqual(data.VendorDetails, [{ VendorID: { value: "BA0000739" }, PurchaseUnit: { value: "EACH" } }]);
      return { id: "mock-item" };
    },
    async getStockItemForVerification(key: string) { assert.equal(key, "mock-item"); return saved; },
  };
  await processCreateStockItemJob(payload, writer, { jobId: "alias-validation" });
  assert.equal(writes, 1);
  await processCreateStockItemJob({ ...payload, manufacturer: " mountain  plumbing products " }, writer);
  assert.equal(writes, 2);
  let reviewRecorded = false;
  await assert.rejects(processCreateStockItemJob({ ...payload, manufacturer: "Unknown Test Manufacturer" }, writer, {
    findMapping: async () => null,
    recordUnresolved: async (key, name, item) => {
      assert.equal(key, "UNKNOWN TEST MANUFACTURER"); assert.equal(item, "MT210EV/EB"); reviewRecorded = true;
    },
  }), ManufacturerMappingNotFoundError);
  assert.equal(reviewRecorded, true); assert.equal(writes, 2);
  const mapping = await prisma.manufacturerMapping.findUniqueOrThrow({ where: { priceClass: "P047" } });
  await assert.rejects(processCreateStockItemJob(payload, {
    ...writer, async getStockItemForVerification() { return { ...saved, PriceClass: { value: "WRONG" } }; },
  }, { findMapping: async () => mapping as StockItemMapping }), StockItemMappingVerificationError);
  assert.equal(writes, 3);
  await assert.rejects(processCreateStockItemJob(payload, {
    ...writer, async getStockItemForVerification() { throw new Error("read timed out"); },
  }, { findMapping: async () => mapping as StockItemMapping }), StockItemMappingVerificationError);
  assert.equal(writes, 4);
  const verificationError = new StockItemMappingVerificationError("TEST", { cause: "timeout" });
  assert.equal(isTransientError(verificationError), false, "verification failure cannot repeat PUT automatically");
  await assert.rejects(processCreateStockItemJob(payload, {
    ...writer, async getStockItemForVerification() { return { ...saved, VendorDetails: [] }; },
  }, { findMapping: async () => mapping as StockItemMapping }), StockItemMappingVerificationError);
  assert.equal(writes, 5);
  const testName = `MLD Alias Validation ${randomUUID()}`;
  const testKey = normalizeManufacturerKey(testName);
  try {
    await assert.rejects(processCreateStockItemJob({ ...payload, manufacturer: testName }, writer,
      { jobId: "alias-review-test-1" }), ManufacturerMappingNotFoundError);
    await assert.rejects(processCreateStockItemJob({ ...payload, manufacturer: testName }, writer,
      { jobId: "alias-review-test-2" }));
    const recorded = await prisma.manufacturerAlias.findUniqueOrThrow({ where: { manufacturerKey: testKey } });
    assert.equal(recorded.seenCount, 2);
    assert.equal(recorded.lastJobId, "alias-review-test-2");
    assert.equal(recorded.status, "pending");
    assert.equal(writes, 5, "review-required requests do not PUT");
    await prisma.manufacturerAlias.update({ where: { manufacturerKey: testKey },
      data: { status: "approved", mappingKey: mapping.manufacturerKey } });
    const result = await processCreateStockItemJob({ ...payload, manufacturer: testName }, writer);
    assert.equal(writes, 6, "approved alias works on retry");
    assert.equal((result as { mappingVerification: { verified: boolean } }).mappingVerification.verified, true);
  } finally {
    await prisma.manufacturerAlias.deleteMany({ where: { manufacturerKey: testKey } });
  }
  console.log(JSON.stringify({ ok: true, acumaticaWrites: 0,
    checks: ["approved alias", "normalized alias", "unknown name review", "price class mismatch", "read failure after PUT"] }));
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
