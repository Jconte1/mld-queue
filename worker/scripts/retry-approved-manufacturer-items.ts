import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ServiceBusClient } from "@azure/service-bus";
import { Prisma } from "../../prisma/generated/client";
import { AcumaticaClient } from "../src/lib/acumaticaClient";
import { findManufacturerMapping } from "../src/lib/createStockItem";
import { normalizeManufacturerKey } from "../src/lib/manufacturerMapping";
import { env } from "../src/lib/env";
import { prisma } from "../src/lib/prisma";

async function main() {
  const requestedItems = process.env.APPROVED_MANUFACTURER_RETRY_ITEMS;
  assert.equal(process.env.APPROVED_MANUFACTURER_RETRY_CONFIRM,
    requestedItems ? `RETRY:${requestedItems}` : "RETRY_THREE_APPROVED_ITEMS");
  assert.equal(env.queueName, "specbooks-jobs", "Retry must use the Specbooks queue");
  const items = requestedItems ? requestedItems.split(",") : ["FS313SB", "KOEC930SJP", "KSES330SPS"];
  assert(items.every(item => item.trim() === item && item.length > 0));
  assert.equal(new Set(items).size, items.length, "Duplicate retry targets are not allowed");
  const candidates = await prisma.job.findMany({ where: { type: "CREATE_STOCK_ITEM", status: "failed" },
    orderBy: { createdAt: "desc" } });
  const plans = [];
  for (const inventoryId of items) {
    const job = candidates.find(job => (job.payload as any)?.InventoryID?.value === inventoryId &&
      String((job.result as any)?.name).startsWith("ManufacturerMapping"));
    assert(job, `No mapping-failed job found for ${inventoryId}`);
    const manufacturer = String((job.payload as any).manufacturer);
    const mapping = await findManufacturerMapping(normalizeManufacturerKey(manufacturer));
    assert(mapping?.status === "approved" && mapping.vendorId, `Mapping not approved for ${manufacturer}`);
    plans.push({ inventoryId, originalJob: job, mapping });
  }
  const directory = path.resolve("../reports");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, `approved-manufacturer-retries-${Date.now()}.json`);
  const report: { plans: typeof plans; results: unknown[] } = { plans, results: [] };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  const serviceBus = new ServiceBusClient(env.serviceBusConnectionString);
  const sender = serviceBus.createSender(env.queueName);
  const client = new AcumaticaClient();
  try {
    for (const plan of plans) {
      const job = plan.originalJob;
      const transition = await prisma.job.updateMany({ where: { id: job.id, status: "failed", updatedAt: job.updatedAt },
        data: { status: "queued", error: null, result: Prisma.DbNull } });
      assert.equal(transition.count, 1, `Job ${job.id} changed since selection; inspect before retrying`);
      try {
        await sender.sendMessages({ messageId: randomUUID(), body: { jobId: job.id, type: job.type,
          vendorId: job.vendorId, payload: job.payload, requestedAt: new Date().toISOString() },
          applicationProperties: { vendorId: job.vendorId, type: job.type } });
      } catch (error) {
        await prisma.job.updateMany({ where: { id: job.id, status: "queued" }, data: { status: "failed",
          error: `Retry enqueue could not be confirmed: ${String(error)}; inspect Service Bus before repeating` } });
        throw error;
      }
      console.log(JSON.stringify({ phase: "retried", jobId: job.id, inventoryId: plan.inventoryId }));
      const deadline = Date.now() + 300000;
      let completed = false;
      while (Date.now() < deadline) {
        const current = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        if (current.status === "failed") {
          report.results.push({ inventoryId: plan.inventoryId, jobId: job.id, status: current.status, error: current.error });
          throw new Error(`Job ${job.id} failed: ${current.error}`);
        }
        if (current.status === "succeeded") {
          const result = current.result as any;
          assert.equal(result.mappingVerification?.verified, true);
          const actual = await client.getStockItemForVerification(result.id) as any;
          assert.equal(actual.ItemClass?.value, plan.mapping.itemClass);
          assert.equal(actual.PriceClass?.value, plan.mapping.priceClass);
          const vendorIds = (actual.VendorDetails ?? []).map((detail: any) => detail.VendorID?.value);
          assert(vendorIds.includes(plan.mapping.vendorId));
          const summary = { inventoryId: plan.inventoryId, jobId: job.id, status: current.status,
            itemClass: actual.ItemClass?.value, priceClass: actual.PriceClass?.value, vendorIds };
          report.results.push(summary);
          console.log(JSON.stringify(summary));
          completed = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      if (!completed) throw new Error(`Timed out waiting for ${job.id}; inspect before retrying`);
    }
  } finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await sender.close();
    await serviceBus.close();
    console.log(JSON.stringify({ reportPath, completed: report.results.length }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
