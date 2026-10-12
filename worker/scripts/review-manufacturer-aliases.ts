import "dotenv/config";
import { normalizeManufacturerKey } from "../src/lib/manufacturerMapping";
import { prisma } from "../src/lib/prisma";

async function main() {
  const args = process.argv.slice(2);
  const argument = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const name = argument("--name");
  const priceClass = argument("--price-class");
  if (name || priceClass) {
    if (!name?.trim() || !priceClass?.trim()) throw new Error("Supply both --name and --price-class");
    const key = normalizeManufacturerKey(name);
    if (!key) throw new Error("Manufacturer name must contain letters or numbers");
    const mapping = await prisma.manufacturerMapping.findUnique({
      where: { priceClass: priceClass.trim().toUpperCase() },
    });
    if (!mapping || mapping.status !== "approved" || !mapping.vendorId) {
      throw new Error("Choose an approved, complete manufacturer mapping");
    }
    const canonical = await prisma.manufacturerMapping.findUnique({ where: { manufacturerKey: key } });
    if (canonical) throw new Error("This name is already canonical; review its mapping directly");
    const vendor = await prisma.vendor.findUnique({ where: { vendorId: mapping.vendorId } });
    if (!vendor) throw new Error("Mapped VendorID is absent from the active vendor table");
    const data = { suppliedName: name.trim(), mappingKey: mapping.manufacturerKey, status: "approved" as const };
    const existing = await prisma.manufacturerAlias.findUnique({ where: { manufacturerKey: key } });
    if (existing?.status === "approved" && existing.mappingKey !== mapping.manufacturerKey) {
      throw new Error("This alias already has a different approval; review it in PostgreSQL before changing it");
    }
    const alias = await prisma.manufacturerAlias.upsert({
      where: { manufacturerKey: key }, create: { manufacturerKey: key, ...data }, update: data,
    });
    console.log(JSON.stringify({ approvedAlias: alias, mapping }, null, 2));
    return;
  }
  const [aliases, pendingMappings, failedJobs] = await Promise.all([
    prisma.manufacturerAlias.findMany({ where: { status: { not: "approved" } }, orderBy: { lastSeenAt: "desc" } }),
    prisma.manufacturerMapping.findMany({ where: { status: { not: "approved" } },
      select: { manufacturerName: true, manufacturerKey: true, priceClass: true, status: true } }),
    prisma.job.findMany({ where: { type: "CREATE_STOCK_ITEM", status: "failed" },
      orderBy: { updatedAt: "desc" }, take: 100,
      select: { id: true, payload: true, error: true, result: true, updatedAt: true } }),
  ]);
  console.log(JSON.stringify({ aliases, pendingMappings, recentFailedCreateJobs: failedJobs }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
