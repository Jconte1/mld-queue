ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'ERP_SYNC_ACTIVE_VENDORS';

CREATE TABLE "vendors" (
  "vendorId" TEXT NOT NULL,
  "vendorName" TEXT NOT NULL,
  "vendorClass" TEXT NOT NULL,
  "vendorClassDescription" TEXT NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vendors_pkey" PRIMARY KEY ("vendorId")
);

CREATE INDEX "vendors_vendorClass_idx" ON "vendors"("vendorClass");
CREATE INDEX "vendors_vendorName_idx" ON "vendors"("vendorName");
