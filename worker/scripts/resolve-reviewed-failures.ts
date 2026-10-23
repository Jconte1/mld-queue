import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";

async function main() {
  assert.equal(process.env.RESOLVE_REVIEWED_FAILURES_CONFIRM, "RESOLVE_VERIFIED_OCTOBER_FAILURES");
  const failed = await prisma.job.findMany({ where: { status: "failed" } });
  const plan: { job: typeof failed[number]; reason: string; replacementJobId?: string }[] = [];
  const stockReplacements: Record<string, string> = {
    "PBSET01-GM": "c5762a24-5f91-4ca6-a882-ed5161d44c5e",
    "BOX02-L-316": "00809b90-dfeb-4692-bc97-3e1f86b179f2",
    "PB SET01.1 INOX": "64a32b5a-e3f3-407f-ae4f-23c344305bb6",
    HARKBN36: "0c03683c-4f24-4b18-bc74-7e4c54087a89",
    "01048875": "730cfc90-a694-4900-9f1f-84356ddaff28",
    KOEC930SJP: "1193555b-5e3e-40d5-b4ac-31e47c6821d4",
    KSES330SPS: "f33ea724-939b-45d7-b90f-d68b4718b98e",
    FS313SB: "771ca96d-9cb1-4701-9b0b-7c8587d74a7f",
    F6IRT365S1: "de8e1977-309f-41e9-b652-7fac549aad54",
    AEL361INRTABSS: "136b3962-9dfd-464d-a248-f82ac554b64c",
  };
  const contactReplacements: Record<string, string> = {
    "contact-backfill-966fb98ddd136150f8abc8c064829bd3": "contact-backfill-598a3a34f6ee62e56582a0acb5bc54fa",
    "contact-backfill-833e452afb9c08e815448db56e9b5c84": "contact-backfill-598a3a34f6ee62e56582a0acb5bc54fa",
    "contact-backfill-add77c81ad82e8b16d633d7ed5947eba": "contact-backfill-70afb99d316e092adffc9f3e0bcc94d8",
  };
  for (const job of failed) {
    const payload = job.payload as any;
    const result = job.result as any;
    let replacementJobId: string | undefined;
    let reason: string | undefined;
    let expectedInvoice: string | undefined;
    if (job.type === "CREATE_STOCK_ITEM" && String(result?.name).startsWith("ManufacturerMapping")) {
      replacementJobId = stockReplacements[payload?.InventoryID?.value];
      if (replacementJobId) reason = "Approved manufacturer alias; replacement stock creation verified in Acumatica";
    } else if (job.id === "39a1b971-cda8-406e-b397-a26147d45046") {
      replacementJobId = "9b33b8da-ba24-4909-80f1-d70b7cf8fc9c";
      reason = "Subsequent identical lookup returned B36CT84SNS successfully";
    } else if (job.id === "d2561976-cb1b-496d-bea3-f9fb63d3e09f") {
      replacementJobId = "db50244a-84be-4070-ac1a-23cc46b692db";
      expectedInvoice = "INV138358";
      reason = "Same Service Fusion reference 38556709 later created invoice INV138358; replacement uses corrected CustomerID BA0011948";
    } else if (job.type === "ERP_PUT_SALES_INVOICE" && job.vendorId === "service_fusion" &&
      payload?.payload?.ExternalRef?.value === "38556656" && payload?.payload?.CustomerID?.value === "BA0012702") {
      replacementJobId = "5b2845dc-94c6-48f4-96e0-47cd4d2739c7";
      expectedInvoice = "INV138750";
      reason = "Credit-hold invoice issue subsequently addressed; same reference successfully created INV138750";
    } else if (job.id === "03913b53-4594-47b6-8a6b-b8e5d66e521a") {
      replacementJobId = "1ee51bd0-473f-4a2f-9bb7-1e053b56d496";
      expectedInvoice = "INV138833";
      reason = "User confirmed HERRIMAN resolved; same reference subsequently created INV138833";
    } else if (contactReplacements[job.id]) {
      replacementJobId = contactReplacements[job.id];
      reason = "Later backfill for the same order completed with contact fields and assignments verified";
    } else if (["a68a8c03-ca0c-462a-b67b-b6441ed8da97", "5b1cd398-c787-4c45-ba22-f38821ffbf9f"].includes(job.id)) {
      assert.equal(job.type, "CREATE_OPPORTUNITY");
      assert.equal(payload.Subject?.value, "2/1 SPURWING ACRES FILTER FAUCET");
      reason = "User confirmed this inactive-item opportunity issue was fixed manually on October 19, 2026; no queue retry performed";
    }
    if (!reason) continue;
    if (replacementJobId) {
      const replacement = await prisma.job.findUniqueOrThrow({ where: { id: replacementJobId } });
      assert.equal(replacement.status, "succeeded");
      assert.equal(replacement.type, job.type);
      assert.equal(replacement.vendorId, job.vendorId);
      assert(replacement.updatedAt > job.updatedAt);
      const replacementPayload = replacement.payload as any;
      const replacementResult = replacement.result as any;
      if (job.type === "CREATE_STOCK_ITEM") {
        assert.equal(replacementPayload.InventoryID?.value, payload.InventoryID?.value);
        assert.equal(replacementPayload.manufacturer, payload.manufacturer);
        assert.equal(replacementResult.mappingVerification?.verified, true);
      } else if (job.type === "GET_STOCK_ITEM") {
        assert.deepEqual(replacementPayload, payload);
        assert(replacementResult.some((item: any) => item.InventoryID?.value === "B36CT84SNS"));
      } else if (job.type === "ERP_PUT_SALES_INVOICE") {
        assert.equal(replacementResult.body?.ExternalRef?.value, payload.payload.ExternalRef?.value);
        assert(expectedInvoice);
        assert.equal(replacementResult.body?.ReferenceNbr?.value, expectedInvoice);
      } else {
        assert.equal(replacementPayload.orderNumber, payload.orderNumber);
        assert.equal(replacementPayload.orderType, payload.orderType);
        assert.equal(replacementResult.status, "completed");
        assert.equal(replacementResult.contactFieldsVerified, true);
        assert.equal(replacementResult.contactAssignmentsVerified, true);
      }
    }
    plan.push({ job, reason, replacementJobId });
  }
  const directory = path.resolve("../reports");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, `resolved-reviewed-failures-${Date.now()}.json`);
  const report = { plannedAt: new Date().toISOString(), plan, applied: false };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await prisma.$transaction(async tx => {
    for (const entry of plan) {
      const changed = await tx.job.updateMany({
        where: { id: entry.job.id, status: "failed", updatedAt: entry.job.updatedAt },
        data: { status: "resolved" },
      });
      assert.equal(changed.count, 1, `Job changed during review: ${entry.job.id}`);
      const saved = await tx.job.findUniqueOrThrow({ where: { id: entry.job.id } });
      assert.deepEqual(saved.payload, entry.job.payload);
      assert.deepEqual(saved.result, entry.job.result);
      assert.equal(saved.error, entry.job.error);
      assert.equal(saved.createdAt.getTime(), entry.job.createdAt.getTime());
    }
  }, { timeout: 30000 });
  report.applied = true;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  const byType: Record<string, number> = {};
  for (const entry of plan) byType[entry.job.type] = (byType[entry.job.type] ?? 0) + 1;
  console.log(JSON.stringify({ resolved: plan.length, byType, reportPath,
    remainingFailures: await prisma.job.groupBy({ by: ["type"], where: { status: "failed" }, _count: true }),
  }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
