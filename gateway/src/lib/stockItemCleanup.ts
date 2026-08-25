import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Prisma } from "../../../prisma/generated/client";
import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs";

const TEMP_WRITE_TEST_MAX_ITEMS = 10;
const DEFAULT_CANDIDATE_POOL_SIZE = 60;
const MAX_CANDIDATE_POOL_SIZE = 100;
const SOURCE_AUDIT_DIR = "reports/acumatica-stock-item-audit-20260824";

type RawCleanupRow = Record<string, unknown>;

type VendorMasterRow = {
  vendorId: string;
  vendorName: string;
  status: string;
  vendorClass: string;
};

export type CreateStockItemCleanupRunInput = {
  dryRun?: boolean;
  writeMode?: boolean;
  maxItems?: number;
  maxInFlight?: number;
  delayMs?: number;
  candidatePoolSize?: number;
  inventoryIds?: string[];
  rows?: RawCleanupRow[];
};

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function upper(value: unknown): string {
  return asString(value).toUpperCase();
}

function intOption(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function possibleReportPath(fileName: string): string[] {
  const configured = process.env.ACUMATICA_STOCK_ITEM_CLEANUP_AUDIT_DIR?.trim();
  const dirs = configured
    ? [configured]
    : [
        path.resolve(process.cwd(), SOURCE_AUDIT_DIR),
        path.resolve(process.cwd(), "..", SOURCE_AUDIT_DIR),
      ];

  return dirs.map((dir) => path.join(dir, fileName));
}

function readJsonArtifact<T>(fileName: string): T {
  const candidates = possibleReportPath(fileName);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Cleanup artifact not found: ${fileName}`);
  }

  return JSON.parse(fs.readFileSync(found, "utf8")) as T;
}

function loadAuditRows(): RawCleanupRow[] {
  return readJsonArtifact<RawCleanupRow[]>("audit-rows.json");
}

function loadVendorMaster(): Map<string, VendorMasterRow> {
  const vendors = readJsonArtifact<RawCleanupRow[]>("vendors.json");
  const map = new Map<string, VendorMasterRow>();

  for (const row of vendors) {
    const vendorId = upper(row.vendorId ?? row.VendorID ?? row["VendorID"]);
    if (!vendorId) continue;

    map.set(vendorId, {
      vendorId,
      vendorName: asString(row.vendorName ?? row.VendorName ?? row["Vendor Name"]),
      status: asString(row.status ?? row.Status),
      vendorClass: upper(row.vendorClass ?? row.VendorClass ?? row["Vendor Class"]),
    });
  }

  return map;
}

function rowInventoryId(row: RawCleanupRow): string {
  return upper(row.InventoryID ?? row.inventoryId ?? row.InventoryId);
}

function rowDescription(row: RawCleanupRow): string {
  return asString(row.Description ?? row.description);
}

function rowCurrentItemClass(row: RawCleanupRow): string {
  return upper(row["Current ItemClass"] ?? row.currentItemClass ?? row.currentItemclass);
}

function rowProposedVendorId(row: RawCleanupRow): string {
  return upper(row["Proposed VendorID"] ?? row.proposedVendorId ?? row.vendorId);
}

function rowProposedVendorName(row: RawCleanupRow): string {
  return asString(row["Proposed VendorName"] ?? row.proposedVendorName ?? row.vendorName);
}

function rowVendorConfidence(row: RawCleanupRow): string {
  return upper(row["Vendor Confidence"] ?? row.vendorConfidence);
}

function rowVendorReason(row: RawCleanupRow): string {
  return asString(row["Vendor Match Reason"] ?? row.vendorMatchReason);
}

function rowAuditStatus(row: RawCleanupRow): string {
  return upper(row.AuditStatus ?? row.auditStatus ?? row.Status ?? row.status);
}

function rowQtyStatus(row: RawCleanupRow): string {
  return upper(row["QtyOnHand Status"] ?? row.qtyOnHandStatus);
}

function vendorClassBucket(vendorClass: string): "PLUMB" | "HARD" | "APPDEFAULT" {
  if (vendorClass === "PLUMB") return "PLUMB";
  if (vendorClass === "HARD") return "HARD";
  return "APPDEFAULT";
}

function candidateScore(row: RawCleanupRow): number {
  const reason = rowVendorReason(row).toUpperCase();
  if (reason.includes("CURRENT STOCKITEM VENDORDETAILS")) return 100;

  const exactEvidence = reason.match(/\bIN\s+(\d+)\/\1\b/);
  if (exactEvidence) return 90 + Math.min(Number(exactEvidence[1]), 50);

  if (reason.includes("MAPS TO")) return 80;
  return 50;
}

function selectCleanupCandidates(input: CreateStockItemCleanupRunInput): RawCleanupRow[] {
  const vendorMaster = loadVendorMaster();
  const sourceRows = input.rows?.length ? input.rows : loadAuditRows();
  const allowedIds = new Set((input.inventoryIds ?? []).map((id) => upper(id)).filter(Boolean));

  const eligible = sourceRows
    .filter((row) => {
      const inventoryId = rowInventoryId(row);
      if (!inventoryId) return false;
      if (allowedIds.size && !allowedIds.has(inventoryId)) return false;

      const auditStatus = rowAuditStatus(row);
      if (auditStatus && auditStatus !== "READY") return false;
      if (rowVendorConfidence(row) !== "HIGH") return false;

      const vendor = vendorMaster.get(rowProposedVendorId(row));
      if (!vendor || vendor.status !== "Active") return false;

      const qtyStatus = rowQtyStatus(row);
      if (qtyStatus && qtyStatus !== "ELIGIBLE") return false;

      return true;
    })
    .sort((a, b) => {
      const bucketOrder = { APPDEFAULT: 0, HARD: 1, PLUMB: 2 };
      const av = vendorMaster.get(rowProposedVendorId(a));
      const bv = vendorMaster.get(rowProposedVendorId(b));
      const bucketDelta =
        bucketOrder[vendorClassBucket(av?.vendorClass ?? "")] -
        bucketOrder[vendorClassBucket(bv?.vendorClass ?? "")];
      if (bucketDelta !== 0) return bucketDelta;
      return rowInventoryId(a).localeCompare(rowInventoryId(b));
    });

  const poolSize = intOption(
    input.candidatePoolSize,
    DEFAULT_CANDIDATE_POOL_SIZE,
    MAX_CANDIDATE_POOL_SIZE
  );
  const selected: RawCleanupRow[] = [];
  const selectedIds = new Set<string>();

  function add(row: RawCleanupRow) {
    const id = rowInventoryId(row);
    if (!id || selectedIds.has(id) || selected.length >= poolSize) return;
    selectedIds.add(id);
    selected.push(row);
  }

  for (const bucket of ["PLUMB", "HARD", "APPDEFAULT"] as const) {
    const rows = eligible
      .filter((row) => vendorClassBucket(vendorMaster.get(rowProposedVendorId(row))?.vendorClass ?? "") === bucket)
      .sort((a, b) => candidateScore(b) - candidateScore(a));
    if (rows[0]) add(rows[0]);
  }

  const remaining = eligible.sort((a, b) => {
    const scoreDelta = candidateScore(b) - candidateScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return rowInventoryId(a).localeCompare(rowInventoryId(b));
  });

  for (const row of remaining) add(row);

  return selected;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export async function createStockItemCleanupRun(input: CreateStockItemCleanupRunInput) {
  const dryRun = input.dryRun ?? true;
  const writeMode = input.writeMode ?? false;
  const maxItems = Math.min(
    intOption(input.maxItems, TEMP_WRITE_TEST_MAX_ITEMS, TEMP_WRITE_TEST_MAX_ITEMS),
    TEMP_WRITE_TEST_MAX_ITEMS
  );
  const maxInFlight = 1;
  const delayMs = Math.min(Math.max(intOption(input.delayMs, 0, 60_000), 0), 60_000);
  const candidates = selectCleanupCandidates(input);

  if (!candidates.length) {
    throw new Error("No eligible HIGH-confidence cleanup candidates found");
  }

  const runId = randomUUID();

  await prisma.stockItemCleanupRun.create({
    data: {
      id: runId,
      dryRun,
      writeMode,
      maxItems,
      maxInFlight,
      delayMs,
      requestedCount: candidates.length,
      items: {
        create: candidates.map((row) => ({
          inventoryId: rowInventoryId(row),
          description: rowDescription(row) || null,
          currentItemClass: rowCurrentItemClass(row) || null,
          proposedVendorId: rowProposedVendorId(row) || null,
          proposedVendorName: rowProposedVendorName(row) || null,
          vendorConfidence: rowVendorConfidence(row) || null,
          vendorMatchReason: rowVendorReason(row) || null,
          sourcePayload: toPrismaJson(row),
        })),
      },
    },
  });

  try {
    const { jobId } = await enqueueJob({
      type: "ERP_STOCK_ITEM_CLEANUP_RUN",
      routeKey: "ERP_STOCK_ITEM_CLEANUP_RUN",
      payload: { runId },
    });

    await prisma.stockItemCleanupRun.update({
      where: { id: runId },
      data: { jobId },
    });

    return {
      runId,
      jobId,
      dryRun,
      writeMode,
      maxItems,
      maxInFlight,
      delayMs,
      candidateCount: candidates.length,
    };
  } catch (error) {
    await prisma.stockItemCleanupRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function getStockItemCleanupRun(runId: string) {
  const run = await prisma.stockItemCleanupRun.findUnique({
    where: { id: runId },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!run) return null;

  const terminalStatuses = new Set([
    "dry_run_ready",
    "updated_successfully",
    "already_updated",
    "skipped_qty_on_hand",
    "skipped_item_class",
    "skipped_vendor_review",
    "failed_api_transient",
    "failed_validation_business_rule",
    "refused_write",
  ]);

  const processed = run.items.filter((item) => terminalStatuses.has(item.status)).length;
  const updated = run.items.filter((item) => item.status === "updated_successfully").length;
  const skipped = run.items.filter((item) => item.status.startsWith("skipped_")).length;
  const failed = run.items.filter((item) => item.status.startsWith("failed_") || item.status === "refused_write").length;

  return {
    runId: run.id,
    jobId: run.jobId,
    status: run.status,
    dryRun: run.dryRun,
    writeMode: run.writeMode,
    maxItems: run.maxItems,
    maxInFlight: run.maxInFlight,
    delayMs: run.delayMs,
    candidateCount: run.requestedCount,
    processed,
    updated,
    skipped,
    failed,
    currentItemId: run.currentItemId,
    lastItemId: run.lastItemId,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    items: run.items.map((item) => ({
      id: item.id,
      inventoryId: item.inventoryId,
      description: item.description,
      status: item.status,
      attemptCount: item.attemptCount,
      oldVendorId: item.oldVendorId,
      oldVendorName: item.oldVendorName,
      newVendorId: item.newVendorId,
      newVendorName: item.newVendorName,
      vendorClass: item.vendorClass,
      oldItemClass: item.oldItemClass,
      newItemClass: item.newItemClass,
      qtyOnHandSummary: item.qtyOnHandSummary,
      verification: item.verification,
      error: item.error,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
    })),
  };
}

export async function resumeStockItemCleanupRun(runId: string) {
  const existing = await prisma.stockItemCleanupRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true },
  });

  if (!existing) return null;

  await prisma.$transaction([
    prisma.stockItemCleanupItem.updateMany({
      where: {
        runId,
        status: { in: ["processing", "failed_api_transient"] },
      },
      data: {
        status: "pending",
        error: null,
        startedAt: null,
      },
    }),
    prisma.stockItemCleanupRun.update({
      where: { id: runId },
      data: {
        status: "queued",
        error: null,
        currentItemId: null,
      },
    }),
  ]);

  const { jobId } = await enqueueJob({
    type: "ERP_STOCK_ITEM_CLEANUP_RUN",
    routeKey: "ERP_STOCK_ITEM_CLEANUP_RUN",
    payload: { runId },
  });

  await prisma.stockItemCleanupRun.update({
    where: { id: runId },
    data: { jobId },
  });

  return { runId, jobId };
}
