CREATE TYPE "ManufacturerMappingStatus" AS ENUM ('pending', 'approved', 'blocked');

CREATE TABLE "manufacturer_mappings" (
  "manufacturerKey" TEXT NOT NULL,
  "manufacturerName" TEXT NOT NULL,
  "priceClass" TEXT NOT NULL,
  "itemClass" TEXT NOT NULL,
  "purchaseUnit" TEXT NOT NULL DEFAULT 'EACH',
  "vendorId" TEXT,
  "vendorName" TEXT,
  "suggestedVendorId" TEXT,
  "suggestedVendorName" TEXT,
  "status" "ManufacturerMappingStatus" NOT NULL DEFAULT 'pending',
  "matchSource" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "manufacturer_mappings_pkey" PRIMARY KEY ("manufacturerKey")
);

CREATE UNIQUE INDEX "manufacturer_mappings_priceClass_key" ON "manufacturer_mappings"("priceClass");
CREATE INDEX "manufacturer_mappings_status_idx" ON "manufacturer_mappings"("status");
CREATE INDEX "manufacturer_mappings_vendorId_idx" ON "manufacturer_mappings"("vendorId");
