CREATE TABLE "manufacturer_aliases" (
  "manufacturerKey" TEXT NOT NULL PRIMARY KEY,
  "suppliedName" TEXT NOT NULL,
  "mappingKey" TEXT,
  "status" "ManufacturerMappingStatus" NOT NULL DEFAULT 'pending',
  "seenCount" INTEGER NOT NULL DEFAULT 0,
  "lastJobId" TEXT,
  "lastInventoryId" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "manufacturer_aliases_mappingKey_fkey" FOREIGN KEY ("mappingKey")
    REFERENCES "manufacturer_mappings"("manufacturerKey") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "manufacturer_aliases_status_lastSeenAt_idx" ON "manufacturer_aliases"("status", "lastSeenAt");
CREATE INDEX "manufacturer_aliases_mappingKey_idx" ON "manufacturer_aliases"("mappingKey");
