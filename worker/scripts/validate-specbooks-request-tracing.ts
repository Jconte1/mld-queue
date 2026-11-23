import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

async function main() {
  // All dependencies are mocked before any handler executes; no live credentials are loaded.
  process.env.SPECBOOKS_API_KEY = "test-secret-api-key";
  process.env.AZURE_SERVICEBUS_CONNECTION_STRING = "Endpoint=sb://test.invalid/;SharedAccessKeyName=test;SharedAccessKey=dGVzdA==";
  process.env.SPECBOOKS_QUEUE_NAME = "specbooks-jobs";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.SPECBOOKS_OPPORTUNITY_PASSTHROUGH = "true";
  const { ServiceBusClient } = createRequire(path.resolve("../gateway/package.json"))("@azure/service-bus");
  const events: Record<string, any>[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = console.error = (raw: string) => { events.push(JSON.parse(raw)); };
  const originalCreateSender = ServiceBusClient.prototype.createSender;
  let sent = 0;
  ServiceBusClient.prototype.createSender = (() => ({
    sendMessages: async () => { sent++; },
  })) as typeof originalCreateSender;
  try {
    const { prisma } = await import("../../gateway/src/lib/prisma");
    const { POST: create } = await import("../../gateway/src/app/api/specbooks/stock-items/route");
    const { POST: opportunity } = await import("../../gateway/src/app/api/specbooks/opportunities/route");
    const { GET: lookup } = await import("../../gateway/src/app/api/specbooks/stock-items/[inventoryId]/route");
    const { GET: poll } = await import("../../gateway/src/app/api/specbooks/jobs/[jobId]/route");
    const { GET: customer } = await import("../../gateway/src/app/api/specbooks/customers/[customerId]/route");
    const { GET: contact } = await import("../../gateway/src/app/api/specbooks/contacts/[contactId]/route");
    const { GET: itemClass } = await import("../../gateway/src/app/api/specbooks/item-classes/[itemClassId]/route");
    const { GET: itemClasses } = await import("../../gateway/src/app/api/specbooks/item-classes/route");
    const { GET: getOpportunity, PATCH: updateOpportunity } = await import("../../gateway/src/app/api/specbooks/opportunities/[opportunityId]/route");
    const { withSpecbooksRequest, traceStage } = await import("../../gateway/src/lib/specbooksRequestTrace");
    const originals = {
      create: prisma.job.create, findMany: prisma.job.findMany,
      findUnique: prisma.job.findUnique, rate: prisma.rateLimitWindow.upsert,
    };
    let databaseFailure = false;
    let rateCount = 1;
    const pollJob = {
      id: "test-job", type: "GET_STOCK_ITEM", vendorId: "specbooks", status: "succeeded",
      result: [{ InventoryID: { value: "TEST-ITEM" } }], error: null,
      createdAt: new Date("2026-11-23T19:00:00Z"), updatedAt: new Date("2026-11-23T19:00:01Z"),
    };
    prisma.job.create = (async () => {
      if (databaseFailure) throw Object.assign(new Error("sensitive-database-credential"), { code: "P1001" });
      return {};
    }) as any;
    prisma.job.findMany = (async () => []) as any;
    prisma.job.findUnique = (async () => pollJob) as any;
    prisma.rateLimitWindow.upsert = (async () => ({ count: rateCount })) as any;
    const request = (path: string, body?: string, authorized = true) => new Request(`https://test.invalid${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(authorized ? { "X-SPECBOOKS-API-KEY": "test-secret-api-key" } : {}),
        "x-correlation-id": "test-correlation-123", "x-vercel-id": "iad1::test-123",
      },
      ...(body === undefined ? {} : { body }),
    });
    try {
      const payload = { InventoryID: { value: "TEST-ITEM" }, Description: { value: "sensitive-product-description" },
        manufacturer: "sensitive-manufacturer", DefaultPrice: { value: "12.50" }, MSRP: { value: "0" } };
      const success = await create(request("/api/specbooks/stock-items", JSON.stringify(payload)));
      assert.equal(success.status, 202, JSON.stringify(events));
      assert.equal(typeof (await success.json()).jobId, "string");
      const queued = events.find(event => event.message === "gateway_job_enqueued");
      assert(queued?.requestId);
      assert.equal(queued.correlationId, "test-correlation-123");
      assert.equal(queued.operation, "CREATE_STOCK_ITEM");
      assert(events.some(event => event.message === "gateway_request_finished" && event.requestId === queued.requestId && event.httpStatus === 202));
      assert.equal((await create(request("/api/specbooks/stock-items", "{}", false))).status, 401);
      const invalid = await create(request("/api/specbooks/stock-items", "{"));
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: "Invalid JSON" });
      const schema = await create(request("/api/specbooks/stock-items", "{}"));
      assert.equal(schema.status, 400);
      assert.equal((await schema.json()).error, "Validation failed");
      assert(events.some(event => event.message === "gateway_validation_rejected" && event.reason === "schema_validation" && event.issueCount > 0));
      assert.equal((await opportunity(request("/api/specbooks/opportunities", "[]"))).status, 400);
      const large = await create(request("/api/specbooks/stock-items", "x".repeat(110000)));
      assert.equal(large.status, 413);
      rateCount = 100000;
      const limited = await create(request("/api/specbooks/stock-items", JSON.stringify(payload)));
      assert.equal(limited.status, 429);
      assert(limited.headers.has("retry-after"));
      assert(events.some(event => event.message === "gateway_request_error" && event.stage === "rate_limit" && event.httpStatus === 429));
      rateCount = 1;
      databaseFailure = true;
      const failure = await create(request("/api/specbooks/stock-items", JSON.stringify(payload)));
      assert.equal(failure.status, 500);
      assert.deepEqual(await failure.json(), { error: "Failed to enqueue job" });
      assert(events.some(event => event.message === "gateway_request_error" && event.stage === "enqueue" && event.errorCode === "P1001"));
      databaseFailure = false;
      const lookupResponse = await lookup(request("/api/specbooks/stock-items/ignored?inventoryIds=B,A"),
        { params: Promise.resolve({ inventoryId: "ignored" }) });
      assert.equal(lookupResponse.status, 202);
      assert(events.some(event => event.message === "gateway_request_payload" && event.inventoryIdCount === 2));
      const polled = await poll(request("/api/specbooks/jobs/test-job"), { params: Promise.resolve({ jobId: "test-job" }) });
      assert.equal(polled.status, 200);
      assert.deepEqual(await polled.json(), JSON.parse(JSON.stringify({ jobId: pollJob.id, vendorId: pollJob.vendorId,
        type: pollJob.type, status: pollJob.status, result: pollJob.result, error: pollJob.error,
        createdAt: pollJob.createdAt, updatedAt: pollJob.updatedAt })));
      assert(events.some(event => event.message === "gateway_job_polled" && event.jobId === "test-job" && event.returnedItemCount === 1));
      assert.equal((await customer(request("/api/specbooks/customers/test"), { params: Promise.resolve({ customerId: "test" }) })).status, 202);
      assert.equal((await contact(request("/api/specbooks/contacts/test"), { params: Promise.resolve({ contactId: "test" }) })).status, 202);
      assert.equal((await itemClass(request("/api/specbooks/item-classes/test"), { params: Promise.resolve({ itemClassId: "test" }) })).status, 202);
      assert.equal((await itemClasses(request("/api/specbooks/item-classes"))).status, 202);
      assert.equal((await getOpportunity(request("/api/specbooks/opportunities/test"), { params: Promise.resolve({ opportunityId: "test" }) })).status, 202);
      assert.equal((await opportunity(request("/api/specbooks/opportunities", JSON.stringify({ Subject: { value: "sensitive-project-name" }, Products: [] })))).status, 202);
      assert.equal((await updateOpportunity(request("/api/specbooks/opportunities/test", "{}", false), { params: Promise.resolve({ opportunityId: "test" }) })).status, 401);
      assert(events.some(event => event.message === "gateway_job_enqueued" && event.operation === "GET_CUSTOMER" && event.route === "/api/specbooks/customers/[customerId]"));
      const response = Response.json({ untouched: true }, { headers: { "x-original": "unchanged" } });
      const wrapped = withSpecbooksRequest("CREATE_OPPORTUNITY", async () => response);
      assert.equal(await wrapped(request("/api/specbooks/opportunities")), response);
      const concurrent = withSpecbooksRequest("GET_STOCK_ITEM", async () => {
        await new Promise(resolve => setTimeout(resolve, 2));
        traceStage("concurrent_test");
        return Response.json({ ok: true });
      });
      const offset = events.length;
      await Promise.all(Array.from({ length: 15 }, () => concurrent(request("/api/specbooks/stock-items/ignored"))));
      const finishes = events.slice(offset).filter(event => event.message === "gateway_request_finished");
      assert.equal(new Set(finishes.map(event => event.requestId)).size, 15);
      assert(finishes.every(event => event.stage === "concurrent_test"));
      const controller = new AbortController();
      const abortRoute = withSpecbooksRequest("POLL_JOB", async () => {
        controller.abort();
        return Response.json({ ok: true });
      });
      await abortRoute(new Request("https://test.invalid/", { signal: controller.signal }));
      assert(events.some(event => event.message === "gateway_request_aborted" && event.requestId));
      const logs = JSON.stringify(events);
      for (const secret of ["test-secret-api-key", "sensitive-product-description", "sensitive-manufacturer", "sensitive-project-name", "sensitive-database-credential", "postgresql://"]) {
        assert(!logs.includes(secret), `Logs leaked ${secret}`);
      }
      assert.equal(sent, 8);
    } finally {
      prisma.job.create = originals.create;
      prisma.job.findMany = originals.findMany;
      prisma.job.findUnique = originals.findUnique;
      prisma.rateLimitWindow.upsert = originals.rate;
      await prisma.$disconnect();
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    ServiceBusClient.prototype.createSender = originalCreateSender;
  }
  console.log("PASS: actual routes, unchanged responses, auth/validation/413/429/500 logging, enqueue correlation, polling, 15 concurrent contexts, abort tracing, and sensitive-data exclusion; no live DB/queue/ERP requests");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
