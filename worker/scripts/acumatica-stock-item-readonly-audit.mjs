import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPORT_DIR = path.resolve(
  process.cwd(),
  "..",
  "reports",
  "acumatica-stock-item-audit-20260824"
);
const SOURCE_ROWS_PATH = path.join(REPORT_DIR, "excel-source-rows.json");

const ITEM_CLASS_MAP = new Map([
  ["PLUMBING", "PLUMB-LOT"],
  ["HARDWARE", "HARD-LOT"],
  ["APPLIANCE", "APLS-RCVD"],
  ["APLS-LOT", "APLS-RCVD"],
  ["APLS-USED", "APLS-RCVD"],
]);

const GENERIC_DESCRIPTION_TOKENS = new Set([
  "ACCESSORY",
  "ADAPTER",
  "APRON",
  "BASKET",
  "BATH",
  "BLACK",
  "BODY",
  "BOWL",
  "BRASS",
  "BRUSHED",
  "CARTRIDGE",
  "CHARGE",
  "CHROME",
  "COLLECTION",
  "CONTROL",
  "COVER",
  "DECK",
  "DIVERTER",
  "DOOR",
  "DRAIN",
  "DRAWER",
  "FAUCET",
  "FINISH",
  "FLOOR",
  "HANDLE",
  "HOLDER",
  "HOOK",
  "INSERT",
  "KIT",
  "KNOB",
  "LAVATORY",
  "LEVER",
  "LINER",
  "MOUNT",
  "PANEL",
  "POLISHED",
  "PRESSURE",
  "PULL",
  "RIGHT",
  "ROUGH",
  "ROUND",
  "SEAT",
  "SERIES",
  "SHOWER",
  "SINGLE",
  "SINK",
  "SOAP",
  "SPRAY",
  "SQUARE",
  "STEEL",
  "STONE",
  "TANK",
  "THERMOSTATIC",
  "TOILET",
  "TOWEL",
  "TRIM",
  "VALVE",
  "VOLUME",
  "WALL",
  "WHITE",
]);

const STOCK_ENDPOINT_NAME =
  process.env.ACUMATICA_STOCK_ITEM_ENDPOINT_NAME?.trim() || "CustomEndpoint";
const STOCK_ENDPOINT_VERSION =
  process.env.ACUMATICA_STOCK_ITEM_ENDPOINT_VERSION?.trim() ||
  process.env.ACUMATICA_ENDPOINT_VERSION?.trim() ||
  "24.200.001";
const VENDOR_ENDPOINT_NAME =
  process.env.ACUMATICA_VENDOR_ENDPOINT_NAME?.trim() || STOCK_ENDPOINT_NAME;
const VENDOR_ENDPOINT_VERSION =
  process.env.ACUMATICA_VENDOR_ENDPOINT_VERSION?.trim() || STOCK_ENDPOINT_VERSION;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function fieldValue(value) {
  if (value && typeof value === "object" && "value" in value) return value.value ?? null;
  return value ?? null;
}

function stringValue(value) {
  const raw = fieldValue(value);
  return raw == null ? "" : String(raw).trim();
}

function numberValue(value) {
  const raw = fieldValue(value);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function quoteOData(value) {
  return String(value).replace(/'/g, "''");
}

function normalizeId(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\r\n");
}

async function token() {
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
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Acumatica token request failed: ${response.status} ${
        data.error_description || data.error || ""
      }`.trim()
    );
  }
  return data.access_token;
}

async function getJson(accessToken, url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message =
      body?.exceptionMessage || body?.message || body?.raw || response.statusText || "unknown";
    const error = new Error(`GET ${url} failed: ${response.status} ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.value)) return payload.value;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function entityUrl(endpointName, endpointVersion, entity, params = null, key = null) {
  const base = `${requiredEnv("ACUMATICA_BASE_URL")}/entity/${endpointName}/${endpointVersion}/${entity}`;
  const keyPart = key ? `/${encodeURIComponent(key)}` : "";
  const query = params ? `?${params.toString()}` : "";
  return `${base}${keyPart}${query}`;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function readWarehouseDetails(row) {
  const details = Array.isArray(row?.WarehouseDetails) ? row.WarehouseDetails : [];
  return details.map((detail) => ({
    warehouse: stringValue(detail.WarehouseID),
    qtyOnHand: numberValue(detail.QtyOnHand),
    status: stringValue(detail.Status),
    preferredVendor: stringValue(detail.PreferredVendor),
  }));
}

function readVendorDetails(row) {
  const details = Array.isArray(row?.VendorDetails) ? row.VendorDetails : [];
  return details
    .map((detail) => ({
      vendorId: stringValue(detail.VendorID),
      vendorName: stringValue(detail.VendorName),
      active: fieldValue(detail.Active) === true,
      default: fieldValue(detail.Default) === true,
      purchaseUnit: stringValue(detail.PurchaseUnit),
      location: stringValue(detail.Location),
      warehouse: stringValue(detail.Warehouse),
      lastVendorPrice: numberValue(detail.LastVendorPrice),
    }))
    .filter((detail) => detail.vendorId);
}

function primaryVendor(vendorDetails) {
  if (!vendorDetails.length) return null;
  return (
    vendorDetails.find((v) => v.active && v.default) ||
    vendorDetails.find((v) => v.active) ||
    vendorDetails.find((v) => v.default) ||
    vendorDetails[0]
  );
}

function prefixCandidates(inventoryId) {
  const id = normalizeId(inventoryId).replace(/[^A-Z0-9]/g, "");
  const candidates = new Set();
  const leadingLetters = id.match(/^[A-Z]{2,}/)?.[0];
  if (leadingLetters) candidates.add(leadingLetters);
  const lettersDigits = id.match(/^[A-Z]{1,5}\d{2,}/)?.[0];
  if (lettersDigits && lettersDigits.length >= 4) {
    candidates.add(lettersDigits.slice(0, Math.min(6, lettersDigits.length)));
    candidates.add(lettersDigits.slice(0, Math.min(5, lettersDigits.length)));
    candidates.add(lettersDigits.slice(0, Math.min(4, lettersDigits.length)));
  }
  if (id.length >= 5) candidates.add(id.slice(0, 5));
  if (id.length >= 4) candidates.add(id.slice(0, 4));
  return [...candidates].filter((value) => value.length >= 3);
}

function usableBrandToken(token) {
  return token.length >= 4 && !/^\d+$/.test(token) && !GENERIC_DESCRIPTION_TOKENS.has(token);
}

function leadingDescriptionTokens(value) {
  const tokens = normalizeText(value).split(" ").filter(Boolean);
  const out = [];
  for (const token of tokens.slice(0, 4)) {
    if (/^\d/.test(token)) break;
    if (usableBrandToken(token)) out.push(token);
  }
  return out;
}

function brandSignalTokens(row) {
  const tokens = new Set();
  for (const value of [row.brand, row.plumbingBrand, row.plumbingSeries]) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    for (const token of normalized.split(" ")) {
      if (usableBrandToken(token)) tokens.add(token);
    }
  }
  for (const token of leadingDescriptionTokens(row.description)) tokens.add(token);
  for (const token of leadingDescriptionTokens(row.liveDescription)) tokens.add(token);
  return [...tokens];
}

function makeStockReference(row) {
  const inventoryId = normalizeId(stringValue(row.InventoryID));
  const description = stringValue(row.Description);
  const itemClass = normalizeId(stringValue(row.ItemClass));
  const vendorDetails = readVendorDetails(row);
  const vendor = primaryVendor(vendorDetails);
  return {
    inventoryId,
    description,
    itemClass,
    vendorId: vendor?.vendorId || "",
    vendorName: vendor?.vendorName || "",
    vendorCount: vendorDetails.length,
    activeVendorCount: vendorDetails.filter((v) => v.active).length,
    prefixes: prefixCandidates(inventoryId),
    brandTokens: new Set(leadingDescriptionTokens(description)),
  };
}

function vendorNameSupportsToken(vendorsById, vendorId, token) {
  const vendor = vendorsById.get(vendorId);
  if (!vendor) return false;
  const normalized = normalizeText(`${vendor.vendorName || ""} ${vendor.legalName || ""}`);
  return normalized.split(" ").includes(token);
}

function chooseVendorForAudit(row, liveItem, stockReferences, vendorsById) {
  const currentVendorDetails = readVendorDetails(liveItem);
  const currentVendor = primaryVendor(currentVendorDetails);
  if (currentVendor?.vendorId) {
    return {
      currentVendor: `${currentVendor.vendorId} ${currentVendor.vendorName}`.trim(),
      proposedVendorId: currentVendor.vendorId,
      proposedVendorName: currentVendor.vendorName,
      confidence: "HIGH",
      reason: `Current StockItem VendorDetails contains ${currentVendorDetails.length} vendor row(s); selected ${
        currentVendor.default ? "default active" : currentVendor.active ? "first active" : "first"
      } VendorID ${currentVendor.vendorId}.`,
      evidence: [],
    };
  }

  const prefixes = prefixCandidates(row.inventoryId);
  const tokenList = brandSignalTokens(row);
  const evidence = [];

  for (const prefix of prefixes) {
    const matches = stockReferences.filter(
      (ref) => ref.vendorId && ref.inventoryId !== row.inventoryId && ref.inventoryId.startsWith(prefix)
    );
    const counts = countBy(matches.map((ref) => ref.vendorId));
    const winners = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (matches.length >= 3 && winners.length === 1) {
      const [vendorId, count] = winners[0];
      evidence.push({
        type: "prefix",
        key: prefix,
        vendorId,
        count,
        total: matches.length,
        examples: matches.slice(0, 5).map((m) => `${m.inventoryId}:${m.vendorId}`),
      });
    } else if (matches.length >= 5 && winners[0] && winners[0][1] / matches.length >= 0.9) {
      const [vendorId, count] = winners[0];
      evidence.push({
        type: "prefix",
        key: prefix,
        vendorId,
        count,
        total: matches.length,
        examples: matches.slice(0, 5).map((m) => `${m.inventoryId}:${m.vendorId}`),
      });
    }
  }

  for (const token of tokenList) {
    const matches = stockReferences.filter(
      (ref) => ref.vendorId && ref.inventoryId !== row.inventoryId && ref.brandTokens.has(token)
    );
    const counts = countBy(matches.map((ref) => ref.vendorId));
    const winners = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (matches.length >= 5 && winners[0] && winners[0][1] / matches.length >= 0.95) {
      const [vendorId, count] = winners[0];
      evidence.push({
        type: "brand-token",
        key: token,
        vendorId,
        count,
        total: matches.length,
        vendorNameSupportsToken: vendorNameSupportsToken(vendorsById, vendorId, token),
        examples: matches.slice(0, 5).map((m) => `${m.inventoryId}:${m.vendorId}`),
      });
    }
  }

  const high = evidence
    .filter(
      (item) =>
        item.count >= 3 &&
        item.count / item.total >= 0.95 &&
        (item.type !== "brand-token" || item.vendorNameSupportsToken)
    )
    .sort((a, b) => b.count / b.total - a.count / a.total || b.count - a.count);
  if (high.length) {
    const winner = high[0];
    const vendor = vendorsById.get(winner.vendorId);
    return {
      currentVendor: "",
      proposedVendorId: winner.vendorId,
      proposedVendorName: vendor?.vendorName || "",
      confidence: "HIGH",
      reason: `${winner.type} ${winner.key} maps to ${winner.vendorId} in ${winner.count}/${winner.total} existing vendor-populated StockItems.`,
      evidence: high.slice(0, 3),
    };
  }

  const medium = evidence
    .filter((item) => item.count >= 2 && item.count / item.total >= 0.75)
    .sort((a, b) => b.count / b.total - a.count / a.total || b.count - a.count);
  if (medium.length) {
    const winner = medium[0];
    const vendor = vendorsById.get(winner.vendorId);
    return {
      currentVendor: "",
      proposedVendorId: winner.vendorId,
      proposedVendorName: vendor?.vendorName || "",
      confidence: "MEDIUM",
      reason: `${winner.type} ${winner.key} suggests ${winner.vendorId} in ${winner.count}/${winner.total} existing vendor-populated StockItems; manual review required.`,
      evidence: medium.slice(0, 3),
    };
  }

  return {
    currentVendor: "",
    proposedVendorId: "",
    proposedVendorName: "",
    confidence: "NONE",
    reason: "No current VendorDetails row and no deterministic existing StockItem pattern met the audit threshold.",
    evidence: [],
  };
}

function countBy(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) || 0) + 1);
  return map;
}

function statusFor(row) {
  if (row.apiStatus !== "FOUND") return row.apiStatus;
  if (row.qtyOnHandStatus === "SKIP_QTY_ON_HAND") return "SKIP_QTY_ON_HAND";
  if (!row.proposedItemClass) return "UNKNOWN_ITEM_CLASS";
  if (row.vendorConfidence !== "HIGH") return "VENDOR_REVIEW_REQUIRED";
  return "READY";
}

function summarize(rows, vendors, stockReferences, apiDiagnostics, duplicateVendorNames) {
  const byStatus = Object.fromEntries([...countBy(rows.map((r) => r.AuditStatus)).entries()]);
  const byQty = Object.fromEntries([...countBy(rows.map((r) => r["QtyOnHand Status"])).entries()]);
  const byVendorConfidence = Object.fromEntries([
    ...countBy(rows.map((r) => r["Vendor Confidence"])).entries(),
  ]);
  const mappingCounts = Object.fromEntries([
    ...countBy(
      rows.map((r) =>
        r["Proposed ItemClass"]
          ? `${r["Current ItemClass"]} -> ${r["Proposed ItemClass"]}`
          : "NO_DEFINED_MAPPING"
      )
    ).entries(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    dataMethodsUsed: ["GET StockItem", "GET Vendor"],
    authMethodNote: "OAuth token retrieval uses the existing password grant; all StockItem/Vendor data calls are GET.",
    endpoints: {
      stockItem: `${STOCK_ENDPOINT_NAME}/${STOCK_ENDPOINT_VERSION}/StockItem`,
      stockItemExpand: "WarehouseDetails,VendorDetails,CrossReferences",
      vendor: `${VENDOR_ENDPOINT_NAME}/${VENDOR_ENDPOINT_VERSION}/Vendor`,
      vendorSelect: "VendorID,VendorName,LegalName,Status,VendorClass,AccountRef",
    },
    totalExcelRows: rows.length,
    totalUniqueInventoryIds: new Set(rows.map((r) => r.InventoryID)).size,
    itemsFound: rows.filter((r) => r.AuditStatus !== "ITEM_NOT_FOUND" && r.AuditStatus !== "API_ERROR").length,
    itemsNotFound: rows.filter((r) => r.AuditStatus === "ITEM_NOT_FOUND").length,
    apiErrors: rows.filter((r) => r.AuditStatus === "API_ERROR").length,
    qtyStatusCounts: byQty,
    auditStatusCounts: byStatus,
    itemClassCorrectionCounts: mappingCounts,
    noDefinedItemClassMapping: rows.filter((r) => !r["Proposed ItemClass"]).length,
    highConfidenceVendor: rows.filter((r) => r["Vendor Confidence"] === "HIGH").length,
    vendorReviewRequired: rows.filter((r) => r.AuditStatus === "VENDOR_REVIEW_REQUIRED").length,
    noVendorInferred: rows.filter((r) => r["Vendor Confidence"] === "NONE").length,
    noWarehouseDetailsRows: rows.filter((r) => r.Warehouses === "(no WarehouseDetails rows)").length,
    vendorRecordsAvailable: vendors.length,
    vendorStatusCounts: Object.fromEntries([...countBy(vendors.map((v) => v.status || "UNKNOWN")).entries()]),
    vendorUsefulFields: ["VendorID", "VendorName", "LegalName", "Status", "VendorClass", "AccountRef"],
    duplicateVendorNameExamples: duplicateVendorNames.slice(0, 25),
    stockReferenceRowsFetched: stockReferences.length,
    stockReferenceRowsWithVendor: stockReferences.filter((ref) => ref.vendorId).length,
    apiDiagnostics,
  };
}

async function fetchVendors(accessToken) {
  const vendors = [];
  const pageSize = 500;
  for (let skip = 0; skip < 20000; skip += pageSize) {
    const params = new URLSearchParams({
      "$select": "VendorID,VendorName,LegalName,Status,VendorClass,AccountRef",
      "$top": String(pageSize),
      "$skip": String(skip),
    });
    const payload = await getJson(
      accessToken,
      entityUrl(VENDOR_ENDPOINT_NAME, VENDOR_ENDPOINT_VERSION, "Vendor", params)
    );
    const rows = rowsFromPayload(payload);
    vendors.push(
      ...rows.map((row) => ({
        vendorId: stringValue(row.VendorID),
        vendorName: stringValue(row.VendorName),
        legalName: stringValue(row.LegalName),
        status: stringValue(row.Status),
        vendorClass: stringValue(row.VendorClass),
        accountRef: stringValue(row.AccountRef),
      }))
    );
    if (rows.length < pageSize) break;
  }
  return vendors;
}

async function fetchStockItems(accessToken, ids) {
  const found = new Map();
  const errors = new Map();
  const pageSize = 20;
  for (const idBatch of chunk(ids, pageSize)) {
    const filter = idBatch.map((id) => `InventoryID eq '${quoteOData(id)}'`).join(" or ");
    const params = new URLSearchParams({
      "$filter": filter,
      "$expand": "WarehouseDetails,VendorDetails,CrossReferences",
      "$top": String(pageSize + 5),
    });
    try {
      const payload = await getJson(
        accessToken,
        entityUrl(STOCK_ENDPOINT_NAME, STOCK_ENDPOINT_VERSION, "StockItem", params)
      );
      for (const row of rowsFromPayload(payload)) {
        found.set(normalizeId(stringValue(row.InventoryID)), row);
      }
    } catch (batchError) {
      for (const id of idBatch) {
        try {
          const paramsForKey = new URLSearchParams({
            "$expand": "WarehouseDetails,VendorDetails,CrossReferences",
          });
          const payload = await getJson(
            accessToken,
            entityUrl(STOCK_ENDPOINT_NAME, STOCK_ENDPOINT_VERSION, "StockItem", paramsForKey, id)
          );
          for (const row of rowsFromPayload(payload)) {
            found.set(normalizeId(stringValue(row.InventoryID)), row);
          }
        } catch (error) {
          errors.set(id, {
            status: error.status || null,
            message: error.message,
          });
        }
      }
    }
  }
  return { found, errors };
}

async function fetchTargetedStockReferences(accessToken, rows, foundStockItems) {
  const referencesById = new Map();
  for (const row of foundStockItems.values()) {
    const ref = makeStockReference(row);
    if (ref.inventoryId) referencesById.set(ref.inventoryId, ref);
  }

  const rowsWithoutCurrentVendor = rows.filter((row) => {
    const liveItem = foundStockItems.get(row.inventoryId);
    return !readVendorDetails(liveItem).length;
  });
  const prefixCounts = countBy(
    rowsWithoutCurrentVendor.flatMap((row) =>
      prefixCandidates(row.inventoryId).filter((prefix) => prefix.length >= 3 && prefix.length <= 8)
    )
  );
  const maxPrefixQueries = Number(process.env.ACUMATICA_AUDIT_MAX_PREFIX_QUERIES || 250);
  const prefixes = [...prefixCounts.entries()]
    .filter(([prefix, count]) => count >= 2 || prefix.length <= 4)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, maxPrefixQueries)
    .map(([prefix]) => prefix);

  for (const prefix of prefixes) {
    const params = new URLSearchParams({
      "$filter": `startswith(InventoryID,'${quoteOData(prefix)}') and ItemStatus eq 'Active'`,
      "$expand": "VendorDetails",
      "$top": "75",
    });
    const payload = await getJson(
      accessToken,
      entityUrl(STOCK_ENDPOINT_NAME, STOCK_ENDPOINT_VERSION, "StockItem", params)
    );
    for (const row of rowsFromPayload(payload)) {
      const ref = makeStockReference(row);
      if (ref.inventoryId) referencesById.set(ref.inventoryId, ref);
    }
  }

  return { references: [...referencesById.values()], prefixesQueried: prefixes };
}

function duplicateVendorNames(vendors) {
  const grouped = new Map();
  for (const vendor of vendors) {
    const name = normalizeText(vendor.vendorName || vendor.legalName);
    if (!name) continue;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(vendor);
  }
  return [...grouped.values()]
    .filter((group) => group.length > 1)
    .map((group) =>
      group.map((vendor) => ({
        VendorID: vendor.vendorId,
        VendorName: vendor.vendorName,
        Status: vendor.status,
      }))
    );
}

async function main() {
  const sourceRows = JSON.parse(await readFile(SOURCE_ROWS_PATH, "utf8"));
  const rows = sourceRows.map((row) => ({
    excelRow: Number(row.ExcelRow),
    inventoryId: normalizeId(row["Inventory ID"]),
    description: String(row.Description || "").trim(),
    currentItemClass: normalizeId(row["Item Class"]),
    spreadsheetVendorId: String(row.VendorID || "").trim(),
    brand: String(row.Brand || "").trim(),
    plumbingBrand: String(row["Plumbing Brand"] || "").trim(),
    plumbingSeries: String(row["Plumbing Series"] || "").trim(),
  }));
  const ids = [...new Set(rows.map((row) => row.inventoryId).filter(Boolean))];

  const accessToken = await token();
  console.error("[audit] token acquired");
  const vendors = await fetchVendors(accessToken);
  console.error(`[audit] vendors fetched: ${vendors.length}`);
  const stock = await fetchStockItems(accessToken, ids);
  console.error(`[audit] workbook StockItems fetched: ${stock.found.size}`);
  const targetedReferences = await fetchTargetedStockReferences(accessToken, rows, stock.found);
  console.error(
    `[audit] targeted reference StockItems: ${targetedReferences.references.length}; prefixes queried: ${targetedReferences.prefixesQueried.length}`
  );
  const vendorsById = new Map(vendors.map((vendor) => [vendor.vendorId, vendor]));
  const stockReferences = targetedReferences.references;
  const apiDiagnostics = {
    batchStockGetRowsFound: stock.found.size,
    stockGetErrors: Object.fromEntries(stock.errors.entries()),
    targetedPrefixQueries: targetedReferences.prefixesQueried.length,
    targetedPrefixes: targetedReferences.prefixesQueried,
  };

  const auditRows = rows.map((row) => {
    const liveItem = stock.found.get(row.inventoryId) || null;
    const error = stock.errors.get(row.inventoryId);
    const proposedItemClass = ITEM_CLASS_MAP.get(row.currentItemClass) || "";
    const liveDescription = liveItem ? stringValue(liveItem.Description) : "";
    const liveItemClass = liveItem ? normalizeId(stringValue(liveItem.ItemClass)) : "";
    const warehouses = liveItem ? readWarehouseDetails(liveItem) : [];
    const positiveWarehouses = warehouses.filter((detail) => detail.qtyOnHand > 0);
    const qtyStatus = !liveItem
      ? ""
      : positiveWarehouses.length
        ? "SKIP_QTY_ON_HAND"
        : "ELIGIBLE";
    const qtyDetails = warehouses.length
      ? warehouses
          .map((detail) => `${detail.warehouse || "(blank)"}=${detail.qtyOnHand}`)
          .join("; ")
      : liveItem
        ? "(no WarehouseDetails rows)"
        : "";
    const vendorDecision = liveItem
      ? chooseVendorForAudit(
          { ...row, liveDescription },
          liveItem,
          stockReferences,
          vendorsById
        )
      : {
          currentVendor: "",
          proposedVendorId: "",
          proposedVendorName: "",
          confidence: "NONE",
          reason: error?.message || "StockItem was not found.",
          evidence: [],
        };
    const apiStatus = liveItem
      ? "FOUND"
      : error?.status === 404 || /No entity satisfies|not found/i.test(error?.message || "")
        ? "ITEM_NOT_FOUND"
        : "API_ERROR";

    const out = {
      InventoryID: row.inventoryId,
      Description: row.description || liveDescription,
      "Live Description": liveDescription,
      "Current ItemClass": row.currentItemClass,
      "Live ItemClass": liveItemClass,
      "Proposed ItemClass": proposedItemClass,
      Warehouses: qtyDetails,
      "QtyOnHand Status": qtyStatus,
      "Current Vendor": vendorDecision.currentVendor,
      "Proposed VendorID": vendorDecision.proposedVendorId,
      "Proposed VendorName": vendorDecision.proposedVendorName,
      "Vendor Confidence": vendorDecision.confidence,
      "Vendor Match Reason": vendorDecision.reason,
      "Spreadsheet VendorID": row.spreadsheetVendorId,
      "API Status": apiStatus,
      AuditStatus: "",
    };
    out.AuditStatus = statusFor({
      apiStatus,
      qtyOnHandStatus: qtyStatus,
      proposedItemClass,
      vendorConfidence: vendorDecision.confidence,
    });
    return out;
  });

  const summary = summarize(
    auditRows,
    vendors,
    stockReferences,
    apiDiagnostics,
    duplicateVendorNames(vendors)
  );

  const columns = [
    "InventoryID",
    "Description",
    "Live Description",
    "Current ItemClass",
    "Live ItemClass",
    "Proposed ItemClass",
    "Warehouses",
    "QtyOnHand Status",
    "Current Vendor",
    "Proposed VendorID",
    "Proposed VendorName",
    "Vendor Confidence",
    "Vendor Match Reason",
    "Spreadsheet VendorID",
    "API Status",
    "AuditStatus",
  ];

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path.join(REPORT_DIR, "audit-summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(REPORT_DIR, "audit-rows.csv"), toCsv(auditRows, columns));
  await writeFile(path.join(REPORT_DIR, "audit-rows.json"), JSON.stringify(auditRows, null, 2));
  await writeFile(path.join(REPORT_DIR, "vendors.json"), JSON.stringify(vendors, null, 2));
  await writeFile(
    path.join(REPORT_DIR, "stock-reference-sample.json"),
    JSON.stringify(stockReferences.filter((ref) => ref.vendorId).slice(0, 200), null, 2)
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
