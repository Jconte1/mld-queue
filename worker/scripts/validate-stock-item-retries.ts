import "dotenv/config";
import assert from "node:assert/strict";
import { processCreateStockItemJob, type StockItemMapping, type StockItemWriter } from "../src/lib/createStockItem";
import { jobRetryDecision } from "../src/lib/jobRetry";

const mapping: StockItemMapping = { manufacturerKey: "KOHLER", manufacturerName: "Kohler",
  priceClass: "P037", itemClass: "PLUMB-LOT", purchaseUnit: "EACH",
  vendorId: "BA0000749", vendorName: "Standard Plumbing Supply", status: "approved" };
const payload = { manufacturer: "Kohler", InventoryID: { value: "TEST_KOHLER" },
  Description: { value: "Test" }, MSRP: { value: 10 }, DefaultPrice: { value: 20 } };
const dependencies = { findMapping: async () => mapping };

function harness(initial: Record<string, unknown> | null = null) {
  let row = initial;
  const writes: Record<string, unknown>[] = [];
  const writer: StockItemWriter = {
    async findStockItemForCreation() { return row ? structuredClone(row) : null; },
    async createStockItem(request) {
      writes.push(structuredClone(request));
      await new Promise(resolve => setTimeout(resolve, 2));
      row = { ...row, ...request, id: "test-entity", InventoryID: { value: "TEST KOHLER" } };
      if (request.VendorDetails) row.VendorDetails = (request.VendorDetails as Record<string, unknown>[])
        .map(detail => ({ id: "vendor-child", ...detail }));
      return structuredClone(row);
    },
    async getStockItemForVerification() { return row ? structuredClone(row) : null; },
  };
  return { writer, writes, getRow: () => row };
}

async function main() {
  const sequential = harness();
  for (let i = 0; i < 15; i++) {
    const result = await processCreateStockItemJob(payload, sequential.writer, dependencies) as any;
    assert.equal(result.mappingVerification.verified, true);
    assert.equal(result.InventoryID.value, "TEST_KOHLER");
  }
  assert.equal(sequential.writes.length, 1, "15 sequential creates produce one PUT");
  assert.equal((sequential.getRow()!.VendorDetails as unknown[]).length, 1);

  const concurrent = harness();
  await Promise.all(Array.from({ length: 15 }, (_, index) =>
    processCreateStockItemJob({ ...payload,
      InventoryID: { value: index % 2 ? "TEST KOHLER" : "TEST_KOHLER" } }, concurrent.writer, dependencies)));
  assert.equal(concurrent.writes.length, 1, "concurrent equivalent IDs produce one PUT");

  await processCreateStockItemJob({ ...payload, DefaultPrice: { value: 25 } }, sequential.writer, dependencies);
  assert.equal(sequential.writes.length, 2, "changed price updates item");
  assert.equal(sequential.writes[1].VendorDetails, undefined, "price update preserves existing vendor row");
  assert.equal(sequential.writes[1].id, "test-entity");
  assert.deepEqual(sequential.writes[1].InventoryID, { value: "TEST KOHLER" });

  const missingVendor = harness({ ...sequential.getRow(), VendorDetails: [] });
  await processCreateStockItemJob(payload, missingVendor.writer, dependencies);
  assert.equal(missingVendor.writes.length, 1, "missing vendor is added");
  assert.equal((missingVendor.getRow()!.VendorDetails as unknown[]).length, 1);

  const wrongUnit = harness({ ...sequential.getRow(), VendorDetails: [{ id: "vendor-child",
    VendorID: { value: mapping.vendorId }, PurchaseUnit: { value: "BOX" } }] });
  await processCreateStockItemJob(payload, wrongUnit.writer, dependencies);
  assert.equal((wrongUnit.writes[0].VendorDetails as any[])[0].id, "vendor-child",
    "unit repair updates the existing child ID");

  let putCount = 0;
  let lookupCount = 0;
  const correct = { ...payload, id: "test-entity", ItemClass: { value: mapping.itemClass },
    PriceClass: { value: mapping.priceClass }, VendorDetails: [{ id: "vendor-child",
      VendorID: { value: mapping.vendorId }, PurchaseUnit: { value: mapping.purchaseUnit } }] };
  const recovered = await processCreateStockItemJob(payload, {
    async findStockItemForCreation() { lookupCount++; return lookupCount === 1 ? null : correct; },
    async createStockItem() { putCount++; throw new Error("Lost PUT response"); },
    async getStockItemForVerification() { throw new Error("Should reuse verified recovery read"); },
  }, dependencies) as any;
  assert.equal(recovered.mappingVerification.verified, true);
  assert.equal(putCount, 1);

  let unsafeWrites = 0;
  await assert.rejects(processCreateStockItemJob(payload, {
    async findStockItemForCreation() { throw new Error("Lookup failed"); },
    async createStockItem() { unsafeWrites++; },
    async getStockItemForVerification() { return null; },
  }, dependencies));
  assert.equal(unsafeWrites, 0, "lookup failures cannot masquerade as missing items");

  assert.deepEqual(jobRetryDecision(true, "CREATE_STOCK_ITEM", 0, 10), { retry: true, exhausted: false, attempt: 1 });
  assert.deepEqual(jobRetryDecision(true, "CREATE_STOCK_ITEM", 8, 10), { retry: true, exhausted: false, attempt: 9 });
  assert.deepEqual(jobRetryDecision(true, "CREATE_STOCK_ITEM", 9, 10), { retry: false, exhausted: true, attempt: 10 });
  assert.equal(jobRetryDecision(true, "CREATE_STOCK_ITEM", 10, 10).exhausted, true);
  assert.equal(jobRetryDecision(false, "CREATE_STOCK_ITEM", 0, 10).retry, false);
  assert.equal(jobRetryDecision(true, "ERP_PUT_SALES_INVOICE", 0, 10).retry, false);
  console.log(JSON.stringify({ ok: true, acumaticaCalls: 0,
    checks: ["15 sequential creates", "15 concurrent creates", "underscore compatibility", "changed price update",
      "vendor reuse", "missing vendor repair", "vendor unit repair", "lost response recovery", "lookup failure", "retry limit"] }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
