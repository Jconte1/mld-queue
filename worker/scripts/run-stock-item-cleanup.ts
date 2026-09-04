import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { AcumaticaClient } from "../src/lib/acumaticaClient";
import { prisma } from "../src/lib/prisma";
import { processStockItemCleanupRunJob } from "../src/lib/stockItemCleanup";

type CleanupItemRow = Awaited<ReturnType<typeof loadItems>>[number];

const REVIEW_STATUSES = new Set([
  "pending",
  "skipped_qty_on_hand",
  "skipped_item_class",
  "skipped_vendor_review",
  "failed_api_transient",
  "failed_validation_business_rule",
  "refused_write",
]);

function runIdArg(): string {
  const explicit = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const runId = explicit || process.env.ACUMATICA_STOCK_ITEM_CLEANUP_RUN_ID || "";
  if (!runId.trim()) {
    throw new Error("Usage: tsx scripts/run-stock-item-cleanup.ts <runId>");
  }
  return runId.trim();
}

function repoRoot(): string {
  const cwd = process.cwd();
  return path.basename(cwd).toLowerCase() === "worker" ? path.dirname(cwd) : cwd;
}

function csvValue(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function csvLine(values: unknown[]): string {
  return values.map(csvValue).join(",");
}

function sourceValue(item: CleanupItemRow, key: string): string {
  const payload = item.sourcePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const value = (payload as Record<string, unknown>)[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function sourceCurrentVendorId(item: CleanupItemRow): string {
  const raw = sourceValue(item, "Current Vendor");
  const match = raw.match(/^([A-Z]{2}\d{7}|BA\d{7})\b/i);
  return match?.[1]?.toUpperCase() || "";
}

function loadVendorClasses(): Map<string, string> {
  const file = path.join(repoRoot(), "reports", "acumatica-stock-item-audit-20260824", "vendors.json");
  if (!fs.existsSync(file)) return new Map();

  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  const vendors = new Map<string, string>();
  for (const row of rows) {
    const vendorId = String(row.vendorId || row.VendorID || "").trim().toUpperCase();
    const vendorClass = String(row.vendorClass || row.VendorClass || "").trim().toUpperCase();
    if (vendorId) vendors.set(vendorId, vendorClass);
  }
  return vendors;
}

function derivedItemClass(vendorId: string, vendorClasses: Map<string, string>): string {
  const vendorClass = vendorClasses.get(vendorId.toUpperCase()) || "";
  if (vendorClass === "PLUMB") return "PLUMB-LOT";
  if (vendorClass === "HARD") return "HARD-LOT";
  return vendorId ? "APLS-RCVD" : "";
}

async function loadItems(runId: string) {
  return prisma.stockItemCleanupItem.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    select: {
      inventoryId: true,
      description: true,
      status: true,
      proposedVendorId: true,
      currentItemClass: true,
      oldVendorId: true,
      newVendorId: true,
      oldItemClass: true,
      newItemClass: true,
      error: true,
      sourcePayload: true,
    },
  });
}

async function counts(runId: string) {
  const grouped = await prisma.stockItemCleanupItem.groupBy({
    by: ["status"],
    where: { runId },
    _count: { _all: true },
  });

  return Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
}

async function printProgress(runId: string): Promise<void> {
  const run = await prisma.stockItemCleanupRun.findUnique({
    where: { id: runId },
    select: { status: true, currentItemId: true, lastItemId: true, error: true },
  });
  const currentCounts = await counts(runId);

  console.log(
    `[cleanup] status=${run?.status ?? "missing"} current=${run?.currentItemId ?? "-"} last=${
      run?.lastItemId ?? "-"
    } counts=${JSON.stringify(currentCounts)}`
  );
}

function masterItemClass(item: CleanupItemRow, vendorClasses: Map<string, string>): string {
  if (item.status === "skipped_qty_on_hand" || item.status.startsWith("failed_")) {
    return (
      item.oldItemClass ||
      sourceValue(item, "Live ItemClass") ||
      sourceValue(item, "Current ItemClass") ||
      item.currentItemClass ||
      ""
    );
  }

  const vendorId = item.newVendorId || item.proposedVendorId || "";
  return (
    item.newItemClass ||
    derivedItemClass(vendorId, vendorClasses) ||
    sourceValue(item, "Proposed ItemClass") ||
    sourceValue(item, "Live ItemClass") ||
    sourceValue(item, "Current ItemClass") ||
    item.currentItemClass ||
    ""
  );
}

function masterVendorId(item: CleanupItemRow): string {
  if (item.status === "skipped_qty_on_hand" || item.status.startsWith("failed_")) {
    return item.oldVendorId || sourceCurrentVendorId(item);
  }
  return item.newVendorId || item.proposedVendorId || sourceCurrentVendorId(item);
}

async function exportReports(runId: string) {
  const vendorClasses = loadVendorClasses();
  const items = await loadItems(runId);
  const outDir = path.join(repoRoot(), "reports", `stock-item-cleanup-${runId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const reviewRows = items.filter((item) => REVIEW_STATUSES.has(item.status));
  const reviewCsv = [
    csvLine(["InventoryID", "Status", "Description", "ItemClass", "VendorID", "Error"]),
    ...reviewRows.map((item) =>
      csvLine([
        item.inventoryId,
        item.status,
        item.description,
        masterItemClass(item, vendorClasses),
        masterVendorId(item),
        item.error,
      ])
    ),
  ].join("\r\n");

  const masterCsv = [
    csvLine(["InventoryID", "ItemClass", "VendorID"]),
    ...items.map((item) =>
      csvLine([item.inventoryId, masterItemClass(item, vendorClasses), masterVendorId(item)])
    ),
  ].join("\r\n");

  const reviewPath = path.join(outDir, "pending-skipped-review.csv");
  const masterPath = path.join(outDir, "master-item-class-vendorid.csv");
  fs.writeFileSync(reviewPath, reviewCsv, "utf8");
  fs.writeFileSync(masterPath, masterCsv, "utf8");

  return {
    reviewPath,
    masterPath,
    reviewCount: reviewRows.length,
    totalCount: items.length,
  };
}

async function reclassifyKnownBusinessFailures(runId: string): Promise<number> {
  const rows = await prisma.stockItemCleanupItem.findMany({
    where: { runId, status: "failed_api_transient" },
    select: { id: true, error: true },
  });

  const businessFailures = rows.filter((row) => {
    const message = String(row.error || "").toLowerCase();
    return (
      message.includes("an error occurred during processing of the field") ||
      message.includes("cannot be changed") ||
      message.includes("purchase receipt")
    );
  });

  for (const row of businessFailures) {
    await prisma.stockItemCleanupItem.update({
      where: { id: row.id },
      data: { status: "failed_validation_business_rule" },
    });
  }

  return businessFailures.length;
}

async function main() {
  const runId = runIdArg();

  const reset = await prisma.stockItemCleanupItem.updateMany({
    where: { runId, status: "processing" },
    data: { status: "pending", startedAt: null, error: null },
  });
  const reclassified = await reclassifyKnownBusinessFailures(runId);
  await prisma.stockItemCleanupRun.update({
    where: { id: runId },
    data: { status: "queued", currentItemId: null, error: null },
  });

  console.log(
    `[cleanup] starting run=${runId} resetProcessing=${reset.count} reclassifiedBusinessFailures=${reclassified}`
  );
  await printProgress(runId);

  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    printProgress(runId)
      .catch((error) => console.error(`[cleanup] progress poll failed: ${error}`))
      .finally(() => {
        polling = false;
      });
  }, 15_000);

  try {
    const result = await processStockItemCleanupRunJob({ runId }, new AcumaticaClient());
    clearInterval(timer);
    await printProgress(runId);
    const reports = await exportReports(runId);

    console.log(JSON.stringify(result, null, 2));
    console.log(`[cleanup] pending/skipped/failed review CSV: ${reports.reviewPath}`);
    console.log(`[cleanup] three-column master CSV: ${reports.masterPath}`);
    console.log(
      `[cleanup] reviewRows=${reports.reviewCount} masterRows=${reports.totalCount}`
    );
  } finally {
    clearInterval(timer);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
