import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AcumaticaClient } from "../src/lib/acumaticaClient";
import { normalizeManufacturerKey } from "../src/lib/manufacturerMapping";
import { prisma } from "../src/lib/prisma";

const baseUrl = process.env.MLD_QUEUE_BASE_URL || "https://mld-queue.vercel.app";
const apiKey = process.env.SPECBOOKS_API_KEY;
const suffix = `${Date.now().toString().slice(-10)}-${randomUUID().slice(0, 4).toUpperCase()}`;
const knownItem = `MLD-E2E-${suffix}`;
const unknownItem = `MLD-E2EU-${suffix}`;
const unknownManufacturer = `MLD Unknown E2E ${suffix}`;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), baseUrl, knownItem, unknownItem };

async function request(route: string, init: RequestInit = {}) {
  assert(apiKey, "SPECBOOKS_API_KEY is required");
  const response = await fetch(`${baseUrl}${route}`, {
    ...init, headers: { "X-SPECBOOKS-API-KEY": apiKey, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Gateway ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function submit(inventoryId: string, manufacturer: string) {
  const payload = { InventoryID: { value: inventoryId }, manufacturer,
    Description: { value: "MLD manufacturer mapping end-to-end test" },
    DefaultPrice: { value: "260.00" }, MSRP: { value: "0.00" } };
  const response = await request("/api/specbooks/stock-items", {
    method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify(payload),
  });
  assert.equal(typeof response.jobId, "string");
  console.log(JSON.stringify({ phase: "submitted", inventoryId, jobId: response.jobId }));
  return response.jobId as string;
}

async function waitForJob(jobId: string) {
  const deadline = Date.now() + 300000;
  let previousStatus = "";
  while (Date.now() < deadline) {
    const job = await request(`/api/specbooks/jobs/${encodeURIComponent(jobId)}`);
    if (job.status !== previousStatus) {
      console.log(JSON.stringify({ phase: "poll", jobId, status: job.status }));
      previousStatus = job.status;
    }
    if (job.status === "succeeded" || job.status === "failed") return job;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`Job ${jobId} did not finish within five minutes; inspect it before rerunning`);
}

function value(row: Record<string, any>, key: string) { return row[key]?.value; }

async function main() {
  assert.equal(process.env.STOCK_ITEM_E2E_CONFIRM, "CREATE_ONE_ITEM_AND_ONE_REVIEW_JOB");
  const mapping = await prisma.manufacturerAlias.findUniqueOrThrow({
    where: { manufacturerKey: "MOUNTAIN PLUMBING PRODUCTS" }, include: { mapping: true },
  });
  assert.equal(mapping.status, "approved");
  assert.equal(mapping.mapping?.status, "approved");
  const knownJobId = await submit(knownItem, "Mountain Plumbing Products");
  report.knownJobId = knownJobId;
  const knownJob = await waitForJob(knownJobId);
  report.knownJob = knownJob;
  assert.equal(knownJob.status, "succeeded", JSON.stringify(knownJob));
  assert.equal(knownJob.result?.mappingVerification?.verified, true,
    "Deployed worker did not provide successful mappingVerification");
  const stored = await prisma.job.findUniqueOrThrow({ where: { id: knownJobId } });
  assert.equal(stored.status, "succeeded");
  assert.equal(typeof (stored.payload as any)?.DefaultPrice?.value, "number");
  const client = new AcumaticaClient();
  const saved = await client.getStockItemForVerification(knownJob.result.id) as Record<string, any>;
  report.savedFields = { inventoryId: value(saved, "InventoryID"), itemClass: value(saved, "ItemClass"),
    priceClass: value(saved, "PriceClass"), vendorIds: (saved.VendorDetails || []).map((v: any) => value(v, "VendorID")) };
  assert.equal(value(saved, "InventoryID"), knownItem);
  assert.equal(value(saved, "ItemClass"), "PLUMB-LOT");
  assert.equal(value(saved, "PriceClass"), "P047");
  assert((saved.VendorDetails || []).some((v: any) => value(v, "VendorID") === "BA0000739"));

  const unknownJobId = await submit(unknownItem, unknownManufacturer);
  report.unknownJobId = unknownJobId;
  const unknownJob = await waitForJob(unknownJobId);
  report.unknownJob = unknownJob;
  assert.equal(unknownJob.status, "failed");
  assert.equal(unknownJob.result?.name, "ManufacturerMappingNotFoundError");
  const review = await prisma.manufacturerAlias.findUniqueOrThrow({
    where: { manufacturerKey: normalizeManufacturerKey(unknownManufacturer) },
  });
  assert.equal(review.status, "pending");
  assert.equal(review.lastJobId, unknownJobId);
  report.review = review;
  try {
    await client.getStockItemForVerification(unknownItem);
    throw new Error("Unknown manufacturer unexpectedly created a stock item");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("No entity satisfies the condition")) throw error;
    report.unknownItemAbsent = true;
  }
  report.ok = true;
}

main().catch(error => {
  report.ok = false; report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
}).finally(async () => {
  report.completedAt = new Date().toISOString();
  const directory = path.resolve("../reports");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, `stock-item-e2e-${suffix}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  await prisma.$disconnect();
});
