ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'ERP_STOCK_ITEM_CLEANUP_RUN';

CREATE TYPE "StockItemCleanupRunStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

CREATE TYPE "StockItemCleanupItemStatus" AS ENUM (
  'pending',
  'processing',
  'dry_run_ready',
  'updated_successfully',
  'already_updated',
  'skipped_qty_on_hand',
  'skipped_item_class',
  'skipped_vendor_review',
  'failed_api_transient',
  'failed_validation_business_rule',
  'refused_write'
);

CREATE TABLE "stock_item_cleanup_runs" (
  "id" TEXT NOT NULL,
  "jobId" TEXT,
  "status" "StockItemCleanupRunStatus" NOT NULL DEFAULT 'queued',
  "dryRun" BOOLEAN NOT NULL DEFAULT true,
  "writeMode" BOOLEAN NOT NULL DEFAULT false,
  "maxItems" INTEGER NOT NULL DEFAULT 10,
  "maxInFlight" INTEGER NOT NULL DEFAULT 1,
  "delayMs" INTEGER NOT NULL DEFAULT 0,
  "requestedCount" INTEGER NOT NULL DEFAULT 0,
  "currentItemId" TEXT,
  "lastItemId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stock_item_cleanup_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_item_cleanup_items" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "inventoryId" TEXT NOT NULL,
  "description" TEXT,
  "currentItemClass" TEXT,
  "proposedVendorId" TEXT,
  "proposedVendorName" TEXT,
  "vendorConfidence" TEXT,
  "vendorMatchReason" TEXT,
  "sourcePayload" JSONB,
  "status" "StockItemCleanupItemStatus" NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "oldVendorId" TEXT,
  "oldVendorName" TEXT,
  "newVendorId" TEXT,
  "newVendorName" TEXT,
  "vendorClass" TEXT,
  "oldItemClass" TEXT,
  "newItemClass" TEXT,
  "qtyOnHandSummary" JSONB,
  "beforeState" JSONB,
  "afterState" JSONB,
  "acumaticaResponse" JSONB,
  "verification" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stock_item_cleanup_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_item_cleanup_runs_jobId_key" ON "stock_item_cleanup_runs"("jobId");
CREATE INDEX "stock_item_cleanup_runs_status_createdAt_idx" ON "stock_item_cleanup_runs"("status", "createdAt");
CREATE UNIQUE INDEX "stock_item_cleanup_items_runId_inventoryId_key" ON "stock_item_cleanup_items"("runId", "inventoryId");
CREATE INDEX "stock_item_cleanup_items_runId_status_createdAt_idx" ON "stock_item_cleanup_items"("runId", "status", "createdAt");
CREATE INDEX "stock_item_cleanup_items_inventoryId_idx" ON "stock_item_cleanup_items"("inventoryId");

ALTER TABLE "stock_item_cleanup_items"
  ADD CONSTRAINT "stock_item_cleanup_items_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "stock_item_cleanup_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
