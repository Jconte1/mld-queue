import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { vendorClassMatchesItemClass } from "../src/lib/manufacturerMapping";
import { prisma } from "../src/lib/prisma";

type JsonRecord = Record<string, unknown>;

type VendorDetail = {
  vendorId: string;
  vendorName: string;
  active: boolean;
  isDefault: boolean;
  purchaseUnit: string;
};

type StockEvidence = {
  inventoryId: string;
  priceClass: string;
  selectedVendor: VendorDetail | null;
  vendorDetails: VendorDetail[];
};

type VendorCount = {
  vendorId: string;
  vendorName: string;
  vendorClass: string;
  count: number;
  activeVendor: boolean;
};

type ActiveVendor = {
  vendorName: string;
  vendorClass: string;
};

const STOCK_ENDPOINT_NAME =
  process.env.ACUMATICA_STOCK_ITEM_ENDPOINT_NAME?.trim() || "CustomEndpoint";
const STOCK_ENDPOINT_VERSION =
  process.env.ACUMATICA_STOCK_ITEM_ENDPOINT_VERSION?.trim() ||
  process.env.ACUMATICA_ENDPOINT_VERSION?.trim() ||
  "24.200.001";
const STOCK_ENTITY = process.env.ACUMATICA_STOCK_ITEM_ENTITY?.trim() || "StockItem";
const PAGE_SIZE = positiveInteger(process.env.MANUFACTURER_VENDOR_AUDIT_PAGE_SIZE, 500, 1000);
const CHUNK_SIZE = positiveInteger(process.env.MANUFACTURER_VENDOR_AUDIT_CHUNK_SIZE, 10, 25);
const MAX_PAGES_PER_CHUNK = positiveInteger(
  process.env.MANUFACTURER_VENDOR_AUDIT_MAX_PAGES_PER_CHUNK,
  40,
  200
);
const REQUEST_TIMEOUT_MS = positiveInteger(
  process.env.ACUMATICA_REQUEST_TIMEOUT_MS,
  180_000,
  600_000
);

let accessToken = "";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function fieldValue(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

function stringValue(value: unknown): string {
  const raw = fieldValue(value);
  return raw == null ? "" : String(raw).trim();
}

function booleanValue(value: unknown): boolean {
  const raw = fieldValue(value);
  return raw === true || String(raw).trim().toLowerCase() === "true";
}

function rowsFromPayload(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (isRecord(payload) && Array.isArray(payload.value)) return payload.value.filter(isRecord);
  return isRecord(payload) ? [payload] : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function quoteOData(value: string): string {
  return value.replace(/'/g, "''");
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: requiredEnv("ACUMATICA_CLIENT_ID"),
    client_secret: requiredEnv("ACUMATICA_CLIENT_SECRET"),
    username: requiredEnv("ACUMATICA_USERNAME"),
    password: requiredEnv("ACUMATICA_PASSWORD"),
    scope: "api offline_access",
  });
  const response = await fetch(`${requiredEnv("ACUMATICA_BASE_URL")}/identity/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Acumatica token request failed: ${response.status} ${
        data.error_description || data.error || response.statusText
      }`
    );
  }
  return data.access_token;
}

async function getJson(url: string, attempt = 1): Promise<unknown> {
  if (!accessToken) accessToken = await requestAccessToken();
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401 && attempt === 1) {
    accessToken = await requestAccessToken();
    return getJson(url, attempt + 1);
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** (attempt - 1));
      return getJson(url, attempt + 1);
    }
    throw new Error(
      `GET StockItem failed: ${response.status} ${response.statusText} ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`.slice(0, 10_000)
    );
  }
  return body;
}

function stockItemUrl(priceClasses: readonly string[], skip: number): string {
  const filter = priceClasses.map((value) => `PriceClass eq '${quoteOData(value)}'`).join(" or ");
  const params = new URLSearchParams({
    "$filter": filter,
    "$expand": "VendorDetails",
    "$top": String(PAGE_SIZE),
    "$skip": String(skip),
  });
  return `${requiredEnv("ACUMATICA_BASE_URL")}/entity/${STOCK_ENDPOINT_NAME}/${STOCK_ENDPOINT_VERSION}/${STOCK_ENTITY}?${params.toString()}`;
}

function readVendorDetails(row: JsonRecord): VendorDetail[] {
  const details = Array.isArray(row.VendorDetails) ? row.VendorDetails.filter(isRecord) : [];
  return details
    .map((detail) => ({
      vendorId: stringValue(detail.VendorID).toUpperCase(),
      vendorName: stringValue(detail.VendorName),
      active: booleanValue(detail.Active),
      isDefault: booleanValue(detail.Default),
      purchaseUnit: stringValue(detail.PurchaseUnit),
    }))
    .filter((detail) => detail.vendorId);
}

function selectPrimaryVendor(details: VendorDetail[]): VendorDetail | null {
  return (
    details.find((detail) => detail.active && detail.isDefault) ||
    details.find((detail) => detail.active) ||
    details.find((detail) => detail.isDefault) ||
    details[0] ||
    null
  );
}

async function fetchEvidence(priceClasses: readonly string[]): Promise<StockEvidence[]> {
  const evidenceByItem = new Map<string, StockEvidence>();
  const groups = chunk(priceClasses, CHUNK_SIZE);

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    let completed = false;
    for (let page = 0; page < MAX_PAGES_PER_CHUNK; page += 1) {
      const skip = page * PAGE_SIZE;
      const rows = rowsFromPayload(await getJson(stockItemUrl(group, skip)));
      for (const row of rows) {
        const inventoryId = stringValue(row.InventoryID).toUpperCase();
        const priceClass = stringValue(row.PriceClass).toUpperCase();
        if (!inventoryId || !priceClasses.includes(priceClass)) continue;
        const vendorDetails = readVendorDetails(row);
        evidenceByItem.set(`${priceClass}\u0000${inventoryId}`, {
          inventoryId,
          priceClass,
          selectedVendor: selectPrimaryVendor(vendorDetails),
          vendorDetails,
        });
      }
      if (rows.length < PAGE_SIZE) {
        completed = true;
        break;
      }
    }
    if (!completed) {
      throw new Error(
        `StockItem audit exceeded ${MAX_PAGES_PER_CHUNK * PAGE_SIZE} rows for PriceClasses ${group.join(", ")}`
      );
    }
    console.error(
      `[manufacturer-vendor-audit] groups ${groupIndex + 1}/${groups.length}; evidence rows ${evidenceByItem.size}`
    );
  }
  return [...evidenceByItem.values()];
}

function rankVendorCounts(
  evidence: StockEvidence[],
  activeVendorsById: Map<string, ActiveVendor>
): VendorCount[] {
  const counts = new Map<string, { count: number; evidenceName: string }>();
  for (const item of evidence) {
    const vendor = item.selectedVendor;
    if (!vendor) continue;
    const current = counts.get(vendor.vendorId) ?? { count: 0, evidenceName: vendor.vendorName };
    current.count += 1;
    if (!current.evidenceName && vendor.vendorName) current.evidenceName = vendor.vendorName;
    counts.set(vendor.vendorId, current);
  }
  return [...counts.entries()]
    .map(([vendorId, value]) => ({
      vendorId,
      vendorName: activeVendorsById.get(vendorId)?.vendorName || value.evidenceName,
      vendorClass: activeVendorsById.get(vendorId)?.vendorClass || "",
      count: value.count,
      activeVendor: activeVendorsById.has(vendorId),
    }))
    .sort((left, right) => right.count - left.count || left.vendorId.localeCompare(right.vendorId));
}

function classification(
  totalItems: number,
  itemsWithVendor: number,
  counts: VendorCount[],
  exactSuggestedVendorId: string | null,
  itemClass: string
): string {
  const winner = counts[0];
  if (!totalItems) return exactSuggestedVendorId ? "EXACT_SUGGESTION_ONLY" : "NO_EXISTING_ITEMS";
  if (!itemsWithVendor || !winner) {
    return exactSuggestedVendorId ? "NO_VENDOR_EVIDENCE_EXACT_SUGGESTION" : "NO_VENDOR_EVIDENCE";
  }
  if (!winner.activeVendor) return "LEADING_VENDOR_NOT_ACTIVE";
  if (!vendorClassMatchesItemClass(winner.vendorClass, itemClass)) {
    return "VENDOR_CLASS_MISMATCH";
  }
  const share = winner.count / itemsWithVendor;
  const secondCount = counts[1]?.count ?? 0;
  if (winner.count >= 3 && share >= 0.95 && secondCount <= 1) {
    return exactSuggestedVendorId && exactSuggestedVendorId !== winner.vendorId
      ? "STRONG_HISTORY_CONFLICTS_WITH_NAME"
      : "STRONG_HISTORY";
  }
  if (counts.length === 1 && winner.count < 3) return "LIMITED_HISTORY";
  return "CONFLICTING_HISTORY";
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: JsonRecord[]): string {
  const columns = Object.keys(rows[0] ?? {});
  return [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\r\n");
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const requestedPriceClasses = new Set(
    (process.env.MANUFACTURER_VENDOR_AUDIT_PRICE_CLASSES || "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  );
  const mappings = await prisma.manufacturerMapping.findMany({
    where: requestedPriceClasses.size
      ? { priceClass: { in: [...requestedPriceClasses] } }
      : undefined,
    orderBy: { priceClass: "asc" },
  });
  if (!mappings.length) throw new Error("No manufacturer mappings matched the audit scope");

  const activeVendors = await prisma.vendor.findMany({
    select: { vendorId: true, vendorName: true, vendorClass: true },
  });
  const activeVendorsById = new Map(
    activeVendors.map((vendor) => [
      vendor.vendorId.toUpperCase(),
      { vendorName: vendor.vendorName, vendorClass: vendor.vendorClass.toUpperCase() },
    ])
  );
  const savedEvidencePath = process.env.MANUFACTURER_VENDOR_AUDIT_EVIDENCE_PATH?.trim();
  const evidence = savedEvidencePath
    ? (JSON.parse(await readFile(savedEvidencePath, "utf8")) as StockEvidence[])
    : await fetchEvidence(mappings.map((mapping) => mapping.priceClass));
  const evidenceByPriceClass = new Map<string, StockEvidence[]>();
  for (const item of evidence) {
    const rows = evidenceByPriceClass.get(item.priceClass) ?? [];
    rows.push(item);
    evidenceByPriceClass.set(item.priceClass, rows);
  }

  const auditRows = mappings.map((mapping) => {
    const items = evidenceByPriceClass.get(mapping.priceClass) ?? [];
    const counts = rankVendorCounts(items, activeVendorsById);
    const itemsWithVendor = items.filter((item) => item.selectedVendor).length;
    const winner = counts[0];
    const winnerShare = winner && itemsWithVendor ? winner.count / itemsWithVendor : 0;
    const category = classification(
      items.length,
      itemsWithVendor,
      counts,
      mapping.suggestedVendorId,
      mapping.itemClass
    );
    return {
      Manufacturer: mapping.manufacturerName,
      ManufacturerKey: mapping.manufacturerKey,
      PriceClass: mapping.priceClass,
      ItemClass: mapping.itemClass,
      CurrentStatus: mapping.status,
      CurrentVendorID: mapping.vendorId ?? "",
      ExactNameSuggestedVendorID: mapping.suggestedVendorId ?? "",
      ExactNameSuggestedVendorName: mapping.suggestedVendorName ?? "",
      ExistingItemCount: items.length,
      ItemsWithVendor: itemsWithVendor,
      ItemsWithoutVendor: items.length - itemsWithVendor,
      CandidateVendorID: winner?.vendorId ?? mapping.suggestedVendorId ?? "",
      CandidateVendorName:
        winner?.vendorName ?? mapping.suggestedVendorName ?? "",
      CandidateVendorClass: winner?.vendorClass ?? "",
      CandidateActive: winner?.activeVendor ?? Boolean(mapping.suggestedVendorId),
      CandidateCount: winner?.count ?? 0,
      CandidateShare: winner ? winnerShare.toFixed(4) : "",
      CompetingVendors: counts
        .slice(1)
        .map(
          (entry) =>
            `${entry.vendorId}:${entry.vendorName}:${entry.vendorClass}:${entry.count}`
        )
        .join("; "),
      Classification: category,
      SampleInventoryIDs: items.slice(0, 10).map((item) => item.inventoryId).join("; "),
      Decision: "",
      ApprovedVendorID: "",
    } satisfies JsonRecord;
  });

  const classificationCounts = Object.fromEntries(
    [...new Set(auditRows.map((row) => String(row.Classification)))].map((name) => [
      name,
      auditRows.filter((row) => row.Classification === name).length,
    ])
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    endpoint: `${requiredEnv("ACUMATICA_BASE_URL")}/entity/${STOCK_ENDPOINT_NAME}/${STOCK_ENDPOINT_VERSION}/${STOCK_ENTITY}`,
    mappingCount: mappings.length,
    stockItemEvidenceCount: evidence.length,
    activeVendorCount: activeVendors.length,
    exactNameSuggestionCount: mappings.filter((mapping) => mapping.suggestedVendorId).length,
    evidenceSource: savedEvidencePath ? path.resolve(savedEvidencePath) : "live Acumatica GET",
    classificationCounts,
    requestSettings: {
      pageSize: PAGE_SIZE,
      priceClassesPerRequest: CHUNK_SIZE,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
  };

  const reportDir = path.resolve(
    process.cwd(),
    "..",
    "reports",
    `manufacturer-vendor-mapping-audit-${timestampForPath()}`
  );
  await mkdir(reportDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2)),
    writeFile(path.join(reportDir, "mapping-review.csv"), toCsv(auditRows)),
    writeFile(path.join(reportDir, "mapping-review.json"), JSON.stringify(auditRows, null, 2)),
    writeFile(path.join(reportDir, "stock-item-evidence.json"), JSON.stringify(evidence, null, 2)),
  ]);
  console.log(JSON.stringify({ ...summary, reportDir }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
