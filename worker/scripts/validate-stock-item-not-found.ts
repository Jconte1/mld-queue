import "dotenv/config";
import assert from "node:assert/strict";
import { jobFailureStatus } from "../src/lib/jobFailureStatus";

async function main() {
  process.env.SPECBOOKS_API_KEY ||= "test-only-no-network";
  process.env.SPECBOOKS_QUEUE_NAME ||= "specbooks-jobs";
  process.env.MLD_QUEUE_TOKEN ||= "test-only-no-network";
  const { getJobById, findRecentReusableStockItemJob } = await import("../../gateway/src/lib/jobs");
  const { prisma } = await import("../../gateway/src/lib/prisma");
  const { jobForPolling, isStockItemNotFoundResult } = await import("../../gateway/src/lib/stockItemLookupOutcome");
  const { GET: specbooksPoll } = await import("../../gateway/src/app/api/specbooks/jobs/[jobId]/route");
  const { GET: erpPoll } = await import("../../gateway/src/app/api/erp/jobs/[jobId]/route");
  const notFound = Object.assign(new Error("Stock item not found: TEST-ITEM"), {
    name: "StockItemNotFoundError", status: 404,
  });
  assert.equal(jobFailureStatus("GET_STOCK_ITEM", notFound), "succeeded");
  for (const type of ["CREATE_STOCK_ITEM", "CREATE_OPPORTUNITY", undefined]) {
    assert.equal(jobFailureStatus(type, notFound), "failed");
  }
  for (const error of [new Error("network failed"), Object.assign(new Error("unauthorized"), { status: 401 }),
    Object.assign(new Error("not found"), { status: 404 }),
    Object.assign(new Error("bad ERP response"), { name: "StockItemNotFoundError", status: 500 }),
    Object.assign(new Error("aborted"), { name: "AbortError" })]) {
    assert.equal(jobFailureStatus("GET_STOCK_ITEM", error), "failed");
  }

  const legacy = {
    id: "test-lookup", vendorId: "specbooks", type: "GET_STOCK_ITEM", status: "failed",
    result: { error: notFound.message, name: notFound.name, status: 404,
      attempt: 1, maxAttempts: 10, retriesExhausted: false },
    error: notFound.message, createdAt: new Date(), updatedAt: new Date(),
  };
  const stored = { ...legacy, status: jobFailureStatus(legacy.type, notFound) };
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.result, legacy.result);
  assert.equal(stored.error, legacy.error);
  assert.deepEqual(jobForPolling(stored), legacy);
  assert.equal(jobForPolling(legacy), legacy);
  assert.equal(jobForPolling({ ...stored, status: "resolved" }).status, "resolved");
  assert.equal(isStockItemNotFoundResult("CREATE_STOCK_ITEM", legacy.result), false);

  const originalFindUnique = prisma.job.findUnique;
  const originalFindMany = prisma.job.findMany;
  let current: unknown = stored;
  let candidates: unknown[] = [{ ...stored, payload: { inventoryIds: ["TEST-ITEM"] } }];
  prisma.job.findUnique = (async () => current) as typeof originalFindUnique;
  prisma.job.findMany = (async () => candidates) as typeof originalFindMany;
  try {
    // Both polling routes consume this exact service response.
    assert.equal(JSON.stringify(await getJobById(legacy.id)), JSON.stringify(legacy));
    for (const [route, headers] of [
      [specbooksPoll, { "X-SPECBOOKS-API-KEY": process.env.SPECBOOKS_API_KEY! }],
      [erpPoll, { Authorization: `Bearer ${process.env.MLD_QUEUE_TOKEN}` }],
    ] as const) {
      const request = new Request("https://test.invalid/api/jobs/test-lookup", { headers });
      const params = { params: Promise.resolve({ jobId: legacy.id }) };
      current = legacy;
      const before = await route(request, params);
      current = stored;
      const after = await route(request, params);
      assert.equal(after.status, before.status);
      assert.deepEqual([...after.headers], [...before.headers]);
      assert.equal(await after.text(), await before.text());
    }
    for (let i = 0; i < 15; i++) {
      assert.equal(await findRecentReusableStockItemJob(["TEST-ITEM"]), null);
    }
    const found = { ...stored, id: "found-after-create", error: null,
      result: [{ InventoryID: { value: "TEST-ITEM" } }], payload: { inventoryIds: ["TEST-ITEM"] } };
    candidates.push(found);
    assert.deepEqual(await findRecentReusableStockItemJob(["TEST-ITEM"]), { jobId: found.id });
    current = found;
    assert.deepEqual(await getJobById(found.id), found);
    candidates = [{ ...found, id: "in-flight", status: "queued", result: null }];
    assert.deepEqual(await findRecentReusableStockItemJob(["TEST-ITEM"]), { jobId: "in-flight" });
    current = null;
    assert.equal(await getJobById("missing-job"), null);
  } finally {
    prisma.job.findUnique = originalFindUnique;
    prisma.job.findMany = originalFindMany;
    await prisma.$disconnect();
  }
  console.log("PASS: DB-only classification, identical HTTP status/headers/body on both polling routes, 15 uncached misses, found/in-flight reuse, and error isolation");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
