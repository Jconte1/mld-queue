import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AcumaticaClient } from "../src/lib/acumaticaClient";
import { prisma } from "../src/lib/prisma";

type Outcome = { durationMs: number; requests: { kind: string; status?: number; durationMs: number }[];
  result?: unknown; error?: { name: string; status?: number } };

function differences(before: any, after: any, location = ""): string[] {
  if (Object.is(before, after)) return [];
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object") return [location];
  if (Array.isArray(before) !== Array.isArray(after)) return [location];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .flatMap(key => differences(before[key], after[key], `${location}.${key}`));
}

async function main() {
  if (process.env.STOCK_LOOKUP_BENCHMARK_REPORT) {
    const file = path.resolve(process.env.STOCK_LOOKUP_BENCHMARK_REPORT);
    const report = JSON.parse(await readFile(file, "utf8"));
    const review = report.runs.map((run: any) => {
      const before = run.legacy.result ?? [];
      const after = run.bulk.result ?? [];
      const key = (row: any) => row.InventoryID?.value;
      const beforeIds = before.map(key);
      const afterIds = after.map(key);
      const addedFields = new Set<string>();
      const removedFields = new Set<string>();
      const changedFields: string[] = [];
      for (const old of before) {
        const current = after.find((row: any) => key(row) === key(old));
        if (!current) continue;
        Object.keys(current).filter(field => !(field in old)).forEach(field => addedFields.add(field));
        Object.keys(old).filter(field => !(field in current)).forEach(field => removedFields.add(field));
        for (const field of Object.keys(old).filter(field => field in current)) {
          changedFields.push(...differences(old[field], current[field], field));
        }
      }
      return { label: run.label, round: run.round, beforeMs: run.legacy.durationMs, afterMs: run.bulk.durationMs,
        beforeRequests: run.legacy.requests.length, afterRequests: run.bulk.requests.length,
        addedInventoryIds: afterIds.filter((id: string) => !beforeIds.includes(id)),
        removedInventoryIds: beforeIds.filter((id: string) => !afterIds.includes(id)),
        addedFields: [...addedFields], removedFields: [...removedFields], changedFields,
        commonItemOrderPreserved: JSON.stringify(beforeIds.filter((id: string) => afterIds.includes(id))) ===
          JSON.stringify(afterIds.filter((id: string) => beforeIds.includes(id))),
        errors: { before: run.legacy.error, after: run.bulk.error } };
    });
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const labels = [...new Set<string>(review.map((run: any) => run.label))];
    const actualOrderRuns = review.filter((run: any) => run.round === 1 && run.label.startsWith("actual-batch-"));
    report.review = {
      deploymentGate: report.passed ? "STRICT_PARITY_PASSED" : "REVIEW_REQUIRED",
      comparisonCount: review.length,
      existingFieldsAndOrderPreserved: review.every((run: any) => !run.removedFields.length &&
        !run.changedFields.length && !run.removedInventoryIds.length && run.commonItemOrderPreserved),
      addedFields: [...new Set(review.flatMap((run: any) => run.addedFields))],
      addedInventoryIds: [...new Set(review.flatMap((run: any) => run.addedInventoryIds))],
      actualOrderFirstPass: {
        beforeMs: actualOrderRuns.reduce((sum: number, run: any) => sum + run.beforeMs, 0),
        afterMs: actualOrderRuns.reduce((sum: number, run: any) => sum + run.afterMs, 0),
        beforeRequests: actualOrderRuns.reduce((sum: number, run: any) => sum + run.beforeRequests, 0),
        afterRequests: actualOrderRuns.reduce((sum: number, run: any) => sum + run.afterRequests, 0),
      },
      timingSummary: labels.map(label => {
        const samples = review.filter((run: any) => run.label === label);
        return { label, repetitions: samples.length,
          beforeMedianMs: median(samples.map((run: any) => run.beforeMs)),
          afterMedianMs: median(samples.map((run: any) => run.afterMs)),
          beforeRequestCounts: [...new Set(samples.map((run: any) => run.beforeRequests))],
          afterRequestCounts: [...new Set(samples.map((run: any) => run.afterRequests))] };
      }),
      runs: review,
    };
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reportPath: file, ...report.review }, null, 2));
    return;
  }
  assert.equal(process.env.STOCK_LOOKUP_BENCHMARK_CONFIRM, "READ_ONLY_ACUMATICA_GETS");
  const sourceIds = ["19f260be-bd38-4f08-a2f7-f113897a4ed8", "5c5dfd9b-4efe-45a1-b63e-d257468de787",
    "5d150d8b-07c6-412e-852f-73b487719704", "ceac2fad-5912-4953-870d-2cce0d03d396", "544c43c4-2e4f-44ff-972c-6827aaaa6b2f"];
  const jobs = await prisma.job.findMany({ where: { id: { in: sourceIds } } });
  assert.equal(jobs.length, sourceIds.length);
  const cases = sourceIds.map((id, index) => {
    const job = jobs.find(job => job.id === id)!;
    assert.equal(job.type, "GET_STOCK_ITEM");
    return { label: `actual-batch-${index + 1}`, sourceJobId: id, ids: (job.payload as any).inventoryIds as string[] };
  });
  cases.push({ label: "special-ids", sourceJobId: "read-only-controls",
    ids: ["BLUES_BID1FS", "MT200EV/PEW", "G-11631-R4**-LM60B-GM-T", "MLD-QUOTE'CONTROL"] });
  cases.push({ label: "all-missing", sourceJobId: "read-only-controls",
    ids: ["MLDLOOKUP-NOTFOUND-12345", "MLDLOOKUP-NOTFOUND-12346"] });
  await prisma.$disconnect();
  const source = await readFile(path.resolve("src/lib/acumaticaClient.ts"), "utf8");
  const report = {
    startedAt: new Date().toISOString(), headCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    clientSourceSha256: createHash("sha256").update(source).digest("hex"),
    execution: "Local machine, same authenticated client, sequential runs; no worker deployment or queue writes",
    comparison: "Original sequential method retained unchanged except extraction/allowMissing parameter; compare all result fields and ordering",
    cases, runs: [] as { label: string; round: number; order: string[]; legacy: Outcome; bulk: Outcome; differences: string[] }[],
    passed: false,
  };
  const directory = path.resolve("../reports");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, `bulk-stock-item-lookups-${Date.now()}.json`);
  const client = new AcumaticaClient() as any;
  const originalRequest = client.request.bind(client);
  let requests: Outcome["requests"] = [];
  client.request = async (url: string, init: RequestInit) => {
    assert.equal(init.method, "GET", "Benchmark must never issue an ERP write");
    const query = new URL(url).searchParams;
    const kind = query.has("$top") ? "bulk" : query.has("$filter") ? "filter" : "direct";
    const startedAt = Date.now();
    try {
      const result = await originalRequest(url, init);
      requests.push({ kind, status: 200, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      requests.push({ kind, status: (error as any).status, durationMs: Date.now() - startedAt });
      throw error;
    }
  };
  const run = async (method: string, ids: string[]): Promise<Outcome> => {
    requests = [];
    const start = Date.now();
    try {
      const result = await client[method](ids);
      return { durationMs: Date.now() - start, requests: [...requests], result };
    } catch (error) {
      return { durationMs: Date.now() - start, requests: [...requests],
        error: { name: (error as Error).name, status: (error as any).status } };
    }
  };
  try {
    await client.getToken();
    for (let round = 0; round < 3; round++) {
      for (const test of cases) {
        if (round > 0 && !["actual-batch-1", "actual-batch-5"].includes(test.label)) continue;
        const order = round % 2 ? ["bulk", "legacy"] : ["legacy", "bulk"];
        const outcome: Partial<Record<"legacy" | "bulk", Outcome>> = {};
        for (const mode of order) {
          console.log(JSON.stringify({ phase: "started", label: test.label, round: round + 1, mode }));
          outcome[mode as "legacy" | "bulk"] = await run(mode === "legacy" ? "getStockItemsSequential" : "getStockItems", test.ids);
        }
        const legacy = outcome.legacy!;
        const bulk = outcome.bulk!;
        const diff = differences({ result: legacy.result, error: legacy.error }, { result: bulk.result, error: bulk.error });
        report.runs.push({ label: test.label, round: round + 1, order, legacy, bulk, differences: diff });
        await writeFile(reportPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ phase: "compared", label: test.label, round: round + 1,
          beforeMs: legacy.durationMs, afterMs: bulk.durationMs, beforeRequests: legacy.requests.length,
          afterRequests: bulk.requests.length, beforeCount: Array.isArray(legacy.result) ? legacy.result.length : undefined,
          afterCount: Array.isArray(bulk.result) ? bulk.result.length : undefined, differenceCount: diff.length,
          differencePaths: diff.slice(0, 10) }));
      }
    }
    report.passed = report.runs.every(run => run.differences.length === 0 && !run.legacy.error && !run.bulk.error);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ phase: "report", reportPath, passed: report.passed, comparisons: report.runs.length }));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
