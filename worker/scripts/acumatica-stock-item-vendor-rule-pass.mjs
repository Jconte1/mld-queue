import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const AUDIT_DIR = path.resolve(
  process.cwd(),
  "..",
  "reports",
  "acumatica-stock-item-audit-20260824"
);
const OUT_DIR = path.resolve(
  process.cwd(),
  "..",
  "reports",
  "acumatica-stock-item-vendor-rule-pass-20260824"
);

const STOCK_ENDPOINT_NAME =
  process.env.ACUMATICA_STOCK_ITEM_ENDPOINT_NAME?.trim() || "CustomEndpoint";
const STOCK_ENDPOINT_VERSION =
  process.env.ACUMATICA_STOCK_ITEM_ENDPOINT_VERSION?.trim() ||
  process.env.ACUMATICA_ENDPOINT_VERSION?.trim() ||
  "24.200.001";

const COMPANY_SUFFIX_TOKENS = new Set([
  "A",
  "AN",
  "AND",
  "CO",
  "COMPANY",
  "CORP",
  "CORPORATION",
  "DBA",
  "GMBH",
  "INC",
  "INCORPORATED",
  "KG",
  "LC",
  "LLC",
  "LTD",
  "LIMITED",
  "NORTH",
  "OF",
  "THE",
  "USA",
  "US",
]);

const GENERIC_ITEM_TOKENS = new Set([
  "ACCESSORY",
  "ADAPTER",
  "ANTIQUE",
  "APRON",
  "ARM",
  "BACK",
  "BAR",
  "BASIC",
  "BASKET",
  "BATH",
  "BATHROOM",
  "BEVERAGE",
  "BLACK",
  "BODY",
  "BOWL",
  "BRASS",
  "BRONZE",
  "BRUSHED",
  "BUTTON",
  "CARTRIDGE",
  "CEILING",
  "CHROME",
  "CLASSIC",
  "COLLECTION",
  "COMPLETE",
  "COMPONENTS",
  "CONTEMPORARY",
  "CONTROL",
  "COVER",
  "CROSS",
  "DARK",
  "DECK",
  "DEGREE",
  "DIVERTER",
  "DOOR",
  "DOWN",
  "DOUBLE",
  "DRAIN",
  "DUAL",
  "ESCUTCHEON",
  "EXPOSED",
  "FILLER",
  "FINISH",
  "FLANGE",
  "FLAT",
  "FLOOR",
  "FREESTANDING",
  "FUNCTION",
  "GOLD",
  "GOOSENECK",
  "GPM",
  "HAND",
  "HANDLE",
  "HANDLES",
  "HANDSHOWER",
  "HEAD",
  "HOLDER",
  "HOLE",
  "HOOK",
  "INTEGRATED",
  "KIT",
  "KITCHEN",
  "LESS",
  "LAVATORY",
  "LEFT",
  "LEVER",
  "LOW",
  "MATTE",
  "MIXER",
  "MODERN",
  "MOUNT",
  "MOUNTED",
  "NATURAL",
  "NICKEL",
  "ONLY",
  "OVERFLOW",
  "PANEL",
  "PAPER",
  "PARTS",
  "PIECE",
  "PLATE",
  "PLATINUM",
  "POLISHED",
  "PRESSURE",
  "PULL",
  "PUSH",
  "PVD",
  "RECTANGULAR",
  "RIGHT",
  "RING",
  "ROBE",
  "ROUGH",
  "ROUND",
  "SATIN",
  "SEAT",
  "SERIES",
  "SET",
  "SHOWER",
  "SHOWERHEAD",
  "SINGLE",
  "SINK",
  "SOAP",
  "SPOUT",
  "SPRAY",
  "SPRAYER",
  "SQUARE",
  "STAINLESS",
  "STEEL",
  "STONE",
  "THERMOSTATIC",
  "TISSUE",
  "TOILET",
  "TOWEL",
  "TRIM",
  "TUB",
  "TWO",
  "UNDERMOUNT",
  "VALVE",
  "VIBRANT",
  "VOLUME",
  "WALL",
  "WASHLET",
  "WATER",
  "WAY",
  "WHITE",
  "WIDESPREAD",
  "WITH",
  "WITHOUT",
]);

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

function normalizeText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/\+/g, " PLUS ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompact(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function regexForNormalizedToken(token) {
  const words = normalizeText(token).split(" ").filter(Boolean);
  if (!words.length) return null;
  return new RegExp(`(^|[^A-Z0-9])${words.map(escapeRegex).join("[^A-Z0-9]+")}($|[^A-Z0-9])`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenMatchesNormalized(token, value) {
  const re = regexForNormalizedToken(token);
  if (!re) return false;
  return re.test(normalizeText(value));
}

function quoteOData(value) {
  return String(value).replace(/'/g, "''");
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [
    columns.join(","),
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
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, body, rows: [] };
  }
  const rows = Array.isArray(body) ? body : body && Array.isArray(body.value) ? body.value : [];
  return { ok: true, status: response.status, body, rows };
}

function stockUrl(params) {
  return `${requiredEnv(
    "ACUMATICA_BASE_URL"
  )}/entity/${STOCK_ENDPOINT_NAME}/${STOCK_ENDPOINT_VERSION}/StockItem?${params.toString()}`;
}

function readVendorDetails(row) {
  const details = Array.isArray(row?.VendorDetails) ? row.VendorDetails : [];
  return details
    .map((detail) => ({
      vendorId: stringValue(detail.VendorID),
      vendorName: stringValue(detail.VendorName),
      active: fieldValue(detail.Active) === true,
      default: fieldValue(detail.Default) === true,
    }))
    .filter((detail) => detail.vendorId);
}

function primaryVendor(vendorDetails) {
  return (
    vendorDetails.find((v) => v.active && v.default) ||
    vendorDetails.find((v) => v.active) ||
    vendorDetails.find((v) => v.default) ||
    vendorDetails[0] ||
    null
  );
}

function countBy(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) || 0) + 1);
  return map;
}

function significantVendorWords(name) {
  return normalizeText(name)
    .split(" ")
    .filter(
      (word) =>
        word.length >= 3 &&
        !COMPANY_SUFFIX_TOKENS.has(word) &&
        !GENERIC_ITEM_TOKENS.has(word) &&
        !/^\d+$/.test(word)
    );
}

function buildVendorLookup(vendors) {
  const active = vendors.filter((vendor) => vendor.status === "Active");
  const byId = new Map(active.map((vendor) => [vendor.vendorId, vendor]));
  const aliasMap = new Map();

  function addAlias(alias, vendor, source) {
    const normalized = normalizeText(alias);
    if (!normalized || normalized.length < 3) return;
    if (!aliasMap.has(normalized)) aliasMap.set(normalized, []);
    const list = aliasMap.get(normalized);
    if (!list.some((item) => item.vendorId === vendor.vendorId)) {
      list.push({ vendorId: vendor.vendorId, vendorName: vendor.vendorName, source });
    }
  }

  for (const vendor of active) {
    for (const [source, name] of [
      ["vendorName", vendor.vendorName],
      ["legalName", vendor.legalName],
    ]) {
      const words = significantVendorWords(name);
      if (!words.length) continue;
      addAlias(words.join(" "), vendor, source);
      if (words[0]?.length >= 4) addAlias(words[0], vendor, `${source}:first-word`);
      if (words.length >= 2) addAlias(words.slice(0, 2).join(" "), vendor, `${source}:first-two`);
    }
  }

  return { active, byId, aliasMap };
}

function descriptionCandidateTokens(row) {
  const description = normalizeText(row.Description);
  const tokens = description.split(" ").filter(Boolean);
  const out = new Set();

  for (const token of tokens.slice(0, 6)) {
    if (
      token.length >= 4 &&
      !/^\d+$/.test(token) &&
      !GENERIC_ITEM_TOKENS.has(token) &&
      !COMPANY_SUFFIX_TOKENS.has(token)
    ) {
      out.add(token);
    }
  }

  for (let i = 0; i < Math.min(tokens.length - 1, 5); i += 1) {
    const pair = [tokens[i], tokens[i + 1]];
    if (
      pair.every((token) => token.length >= 3 && !/^\d+$/.test(token)) &&
      pair.every(
        (token) => !GENERIC_ITEM_TOKENS.has(token) && !COMPANY_SUFFIX_TOKENS.has(token)
      )
    ) {
      out.add(pair.join(" "));
    }
  }

  const reason = String(row["Vendor Match Reason"] || "");
  const reasonMatch = reason.match(/^(?:brand-token|prefix)\s+([A-Z0-9 -]+)/i);
  if (reasonMatch) out.add(normalizeText(reasonMatch[1]));

  return [...out].filter(Boolean);
}

function inventoryPrefixCandidates(row) {
  const id = String(row.InventoryID || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const out = new Set();
  const leadingLetters = id.match(/^[A-Z]{3,}/)?.[0];
  if (leadingLetters && leadingLetters.length <= 8) out.add(leadingLetters);
  if (id.length >= 4) out.add(id.slice(0, 4));
  if (id.length >= 5) out.add(id.slice(0, 5));
  return [...out].filter((token) => token.length >= 3);
}

function reviewItemsForToken(reviewRows, token, source) {
  const re = regexForNormalizedToken(token);
  if (!re && source !== "inventory-prefix") return [];
  return reviewRows.filter((row) => {
    if (source === "inventory-prefix") {
      return normalizeCompact(row.InventoryID).startsWith(normalizeCompact(token));
    }
    return re.test(normalizeText(row.Description));
  });
}

function searchVariants(token) {
  const normalized = normalizeText(token);
  const variants = new Set([normalized]);
  if (normalized.includes(" ")) {
    variants.add(normalized.replace(/\s+/g, "-"));
    variants.add(normalized.replace(/\s+/g, ""));
  }
  return [...variants].filter((value) => value.length >= 3).slice(0, 3);
}

async function fetchDescriptionEvidence(accessToken, token, reviewIds) {
  const byInventoryId = new Map();
  for (const variant of searchVariants(token)) {
    const params = new URLSearchParams({
      "$filter": `substringof('${quoteOData(variant)}',Description) and ItemStatus eq 'Active'`,
      "$expand": "VendorDetails",
      "$top": "100",
    });
    const result = await getJson(accessToken, stockUrl(params));
    for (const row of result.rows) {
      const inventoryId = stringValue(row.InventoryID).toUpperCase();
      if (!inventoryId || reviewIds.has(inventoryId)) continue;
      if (!tokenMatchesNormalized(token, stringValue(row.Description))) continue;
      const vendor = primaryVendor(readVendorDetails(row));
      if (!vendor?.vendorId) continue;
      byInventoryId.set(inventoryId, {
        inventoryId,
        description: stringValue(row.Description),
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
      });
    }
  }
  return [...byInventoryId.values()];
}

async function fetchPrefixEvidence(accessToken, prefix, reviewIds) {
  const params = new URLSearchParams({
    "$filter": `startswith(InventoryID,'${quoteOData(prefix)}') and ItemStatus eq 'Active'`,
    "$expand": "VendorDetails",
    "$top": "100",
  });
  const result = await getJson(accessToken, stockUrl(params));
  return result.rows
    .map((row) => {
      const inventoryId = stringValue(row.InventoryID).toUpperCase();
      const vendor = primaryVendor(readVendorDetails(row));
      return {
        inventoryId,
        description: stringValue(row.Description),
        vendorId: vendor?.vendorId || "",
        vendorName: vendor?.vendorName || "",
      };
    })
    .filter((row) => row.inventoryId && row.vendorId && !reviewIds.has(row.inventoryId));
}

function classifyRule(params) {
  const {
    token,
    source,
    affectedCount,
    masterCandidates,
    evidenceRows,
    activeVendorById,
  } = params;

  const evidenceCounts = [...countBy(evidenceRows.map((row) => row.vendorId)).entries()].sort(
    (a, b) => b[1] - a[1]
  );
  const totalEvidence = evidenceRows.length;
  const winner = evidenceCounts[0] || null;
  const winnerVendor = winner ? activeVendorById.get(winner[0]) : null;
  const winnerShare = winner && totalEvidence ? winner[1] / totalEvidence : 0;
  const secondCount = evidenceCounts[1]?.[1] || 0;
  const uniqueMasterCandidates = masterCandidates.filter(
    (candidate, index, all) =>
      all.findIndex((item) => item.vendorId === candidate.vendorId) === index
  );
  const vendorNameSupportsToken = winnerVendor
    ? tokenMatchesNormalized(token, `${winnerVendor.vendorName} ${winnerVendor.legalName}`)
    : false;
  const exactMasterWinner =
    winner && uniqueMasterCandidates.some((candidate) => candidate.vendorId === winner[0]);

  if (winner && totalEvidence >= 3 && winnerShare >= 0.95) {
    if (
      (vendorNameSupportsToken || source === "inventory-prefix") &&
      (evidenceCounts.length === 1 || secondCount <= 1 || winnerShare >= 0.99)
    ) {
      return {
        classification: "HIGH",
        vendorId: winner[0],
        vendorName: winnerVendor?.vendorName || evidenceRows.find((r) => r.vendorId === winner[0])?.vendorName || "",
        reason:
          source === "inventory-prefix"
            ? `InventoryID prefix evidence maps ${token} to ${winner[0]} in ${winner[1]}/${totalEvidence} vendor-populated StockItems.`
            : `Existing vendor-populated StockItems map ${token} to ${winner[0]} in ${winner[1]}/${totalEvidence}, and the active vendor master supports the token or exact vendor relationship.`,
      };
    }

    return {
      classification: "BUSINESS_RULE_APPROVAL",
      vendorId: winner[0],
      vendorName: winnerVendor?.vendorName || evidenceRows.find((r) => r.vendorId === winner[0])?.vendorName || "",
      reason: `Existing vendor-populated StockItems consistently map ${token} to ${winner[0]} in ${winner[1]}/${totalEvidence}, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation.`,
    };
  }

  if (winner && totalEvidence >= 3 && winnerShare >= 0.9 && exactMasterWinner) {
    return {
      classification: "BUSINESS_RULE_APPROVAL",
      vendorId: winner[0],
      vendorName: winnerVendor?.vendorName || evidenceRows.find((r) => r.vendorId === winner[0])?.vendorName || "",
      reason: `Token ${token} directly matches an active Acumatica vendor and existing StockItems mostly map it to ${winner[0]} (${winner[1]}/${totalEvidence}); review the minority vendor conflicts before approving automation.`,
    };
  }

  if (uniqueMasterCandidates.length === 1 && totalEvidence === 0 && affectedCount >= 2) {
    const vendor = activeVendorById.get(uniqueMasterCandidates[0].vendorId);
    return {
      classification: "HIGH",
      vendorId: uniqueMasterCandidates[0].vendorId,
      vendorName: vendor?.vendorName || uniqueMasterCandidates[0].vendorName,
      reason: `Token ${token} exactly matches one active Acumatica vendor alias; no conflicting vendor-populated StockItem evidence was found in the sampled read-only query.`,
    };
  }

  if (evidenceCounts.length > 1 || uniqueMasterCandidates.length > 1) {
    return {
      classification: "AMBIGUOUS",
      vendorId: winner?.[0] || uniqueMasterCandidates[0]?.vendorId || "",
      vendorName:
        (winner && activeVendorById.get(winner[0])?.vendorName) ||
        uniqueMasterCandidates[0]?.vendorName ||
        "",
      reason: `Token ${token} has multiple plausible vendors from ${
        evidenceCounts.length > 1 ? "existing StockItem evidence" : "active vendor aliases"
      }.`,
    };
  }

  return {
    classification: "NO_MATCH",
    vendorId: "",
    vendorName: "",
    reason: `No active vendor alias or consistent existing StockItem vendor evidence matched ${token}.`,
  };
}

function groupedImpact(rules, classification) {
  const covered = new Set();
  for (const rule of rules.filter((rule) => rule.classification === classification)) {
    for (const id of rule.matchingInventoryIds) covered.add(id);
  }
  return covered;
}

function selectBestRules(rules, classification) {
  const covered = new Set();
  const selected = [];
  for (const rule of rules.filter((rule) => rule.classification === classification)) {
    const newIds = rule.matchingInventoryIds.filter((id) => !covered.has(id));
    if (!newIds.length) continue;
    selected.push({ ...rule, incrementalImpact: newIds.length });
    for (const id of newIds) covered.add(id);
  }
  return { selected, covered };
}

async function main() {
  const auditRows = JSON.parse(await readFile(path.join(AUDIT_DIR, "audit-rows.json"), "utf8"));
  const vendorRows = JSON.parse(await readFile(path.join(AUDIT_DIR, "vendors.json"), "utf8"));
  const reviewRows = auditRows.filter((row) => row.AuditStatus === "VENDOR_REVIEW_REQUIRED");
  const reviewIds = new Set(reviewRows.map((row) => String(row.InventoryID).toUpperCase()));
  const { active, byId: activeVendorById, aliasMap } = buildVendorLookup(vendorRows);

  const tokenSources = new Map();
  function addToken(token, source, row) {
    const normalized = normalizeText(token);
    if (!normalized || normalized.length < 3) return;
    if (GENERIC_ITEM_TOKENS.has(normalized) || COMPANY_SUFFIX_TOKENS.has(normalized)) return;
    if (!tokenSources.has(normalized)) {
      tokenSources.set(normalized, { token: normalized, sources: new Set(), inventoryIds: new Set() });
    }
    const entry = tokenSources.get(normalized);
    entry.sources.add(source);
    entry.inventoryIds.add(row.InventoryID);
  }

  for (const row of reviewRows) {
    for (const token of descriptionCandidateTokens(row)) addToken(token, "description-token", row);
    for (const prefix of inventoryPrefixCandidates(row)) addToken(prefix, "inventory-prefix", row);
  }

  for (const row of reviewRows) {
    const description = normalizeText(row.Description);
    for (const alias of aliasMap.keys()) {
      if (alias.length < 4 || GENERIC_ITEM_TOKENS.has(alias)) continue;
      if (tokenMatchesNormalized(alias, description)) addToken(alias, "active-vendor-alias", row);
    }
  }

  const candidates = [...tokenSources.values()]
    .map((entry) => ({
      token: entry.token,
      sources: [...entry.sources],
      initialImpact: entry.inventoryIds.size,
    }))
    .filter((entry) => entry.initialImpact >= 2)
    .sort((a, b) => b.initialImpact - a.initialImpact || a.token.localeCompare(b.token))
    .slice(0, Number(process.env.ACUMATICA_VENDOR_RULE_MAX_TOKENS || 180));

  const accessToken = await token();
  console.error(`[vendor-rule-pass] review rows: ${reviewRows.length}`);
  console.error(`[vendor-rule-pass] active vendors: ${active.length}`);
  console.error(`[vendor-rule-pass] candidate tokens: ${candidates.length}`);

  const rules = [];
  let index = 0;
  for (const candidate of candidates) {
    index += 1;
    const source = candidate.sources.includes("inventory-prefix")
      ? "inventory-prefix"
      : candidate.sources.includes("active-vendor-alias")
        ? "active-vendor-alias"
        : "description-token";
    const affectedRows = reviewItemsForToken(reviewRows, candidate.token, source);
    if (affectedRows.length < 2) continue;

    const evidenceRows =
      source === "inventory-prefix"
        ? await fetchPrefixEvidence(accessToken, candidate.token, reviewIds)
        : await fetchDescriptionEvidence(accessToken, candidate.token, reviewIds);
    const masterCandidates = aliasMap.get(candidate.token) || [];
    const classification = classifyRule({
      token: candidate.token,
      source,
      affectedCount: affectedRows.length,
      masterCandidates,
      evidenceRows,
      activeVendorById,
    });
    const evidenceCounts = [...countBy(evidenceRows.map((row) => row.vendorId)).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([vendorId, count]) => ({
        vendorId,
        vendorName: activeVendorById.get(vendorId)?.vendorName || evidenceRows.find((r) => r.vendorId === vendorId)?.vendorName || "",
        count,
      }));
    const pattern =
      source === "inventory-prefix"
        ? `^${candidate.token}`
        : `\\b${candidate.token.split(" ").join("[\\\\s-]+")}\\b`;

    rules.push({
      token: candidate.token,
      source,
      regex: pattern,
      classification: classification.classification,
      candidateVendorId: classification.vendorId,
      candidateVendorName: classification.vendorName,
      affectedReviewItems: affectedRows.length,
      matchingInventoryIds: affectedRows.map((row) => row.InventoryID),
      sampleMatchingDescriptions: affectedRows.slice(0, 8).map((row) => ({
        inventoryId: row.InventoryID,
        description: row.Description,
        priorCandidateVendorId: row["Proposed VendorID"],
        priorReason: row["Vendor Match Reason"],
      })),
      activeVendorAliasCandidates: masterCandidates,
      supportingExistingGoodItems: evidenceRows.slice(0, 12),
      evidenceVendorCounts: evidenceCounts,
      reason: classification.reason,
    });

    if (index % 25 === 0) {
      console.error(`[vendor-rule-pass] processed ${index}/${candidates.length}`);
    }
  }

  rules.sort(
    (a, b) =>
      b.affectedReviewItems - a.affectedReviewItems ||
      a.classification.localeCompare(b.classification) ||
      a.token.localeCompare(b.token)
  );

  const selectedHigh = selectBestRules(rules, "HIGH");
  const selectedApproval = selectBestRules(
    rules.filter((rule) => !selectedHigh.covered.has(rule.matchingInventoryIds[0])),
    "BUSINESS_RULE_APPROVAL"
  );
  const highCovered = groupedImpact(rules, "HIGH");
  const businessCovered = groupedImpact(rules, "BUSINESS_RULE_APPROVAL");
  const ambiguousCovered = groupedImpact(rules, "AMBIGUOUS");
  const noMatchCovered = groupedImpact(rules, "NO_MATCH");
  const remainingAfterHigh = reviewRows.filter((row) => !highCovered.has(row.InventoryID)).length;
  const remainingAfterHighAndApproval = reviewRows.filter(
    (row) => !highCovered.has(row.InventoryID) && !businessCovered.has(row.InventoryID)
  ).length;

  const summary = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    dataMethodsUsed: ["GET StockItem"],
    sourceAuditDir: AUDIT_DIR,
    currentReviewCount: reviewRows.length,
    activeVendorCount: active.length,
    inactiveVendorCount: vendorRows.filter((vendor) => vendor.status !== "Active").length,
    candidateRules: rules.length,
    ruleClassificationCounts: Object.fromEntries(countBy(rules.map((rule) => rule.classification))),
    numberResolvableByHighRules: highCovered.size,
    potentiallyResolvableByBusinessRuleApproval: [...businessCovered].filter(
      (id) => !highCovered.has(id)
    ).length,
    numberRemainingAfterHighRules: remainingAfterHigh,
    numberRemainingAfterHighAndBusinessApproval: remainingAfterHighAndApproval,
    numberWithAmbiguousTokenVendorMatch: [...ambiguousCovered].filter(
      (id) => !highCovered.has(id) && !businessCovered.has(id)
    ).length,
    numberCoveredOnlyByNoMatchRules: [...noMatchCovered].filter(
      (id) => !highCovered.has(id) && !businessCovered.has(id) && !ambiguousCovered.has(id)
    ).length,
    topHighRules: rules.filter((rule) => rule.classification === "HIGH").slice(0, 20),
    topBusinessApprovalRules: rules
      .filter((rule) => rule.classification === "BUSINESS_RULE_APPROVAL")
      .slice(0, 20),
    topAmbiguousRules: rules.filter((rule) => rule.classification === "AMBIGUOUS").slice(0, 20),
  };

  const reportRows = rules.map((rule) => ({
    Token: rule.token,
    Regex: rule.regex,
    Source: rule.source,
    Classification: rule.classification,
    CandidateVendorID: rule.candidateVendorId,
    CandidateVendorName: rule.candidateVendorName,
    MatchingReviewItems: rule.affectedReviewItems,
    EvidenceVendorCounts: rule.evidenceVendorCounts
      .map((item) => `${item.vendorId}:${item.vendorName}:${item.count}`)
      .join("; "),
    ActiveVendorAliasCandidates: rule.activeVendorAliasCandidates
      .map((item) => `${item.vendorId}:${item.vendorName}`)
      .join("; "),
    SampleInventoryIDs: rule.matchingInventoryIds.slice(0, 12).join("; "),
    Reason: rule.reason,
  }));

  const markdown = [
    "# Vendor Rule Candidate Pass",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Current review count: ${summary.currentReviewCount}`,
    `- Active vendors considered eligible: ${summary.activeVendorCount}`,
    `- Candidate rules evaluated: ${summary.candidateRules}`,
    `- Resolvable by HIGH rules: ${summary.numberResolvableByHighRules}`,
    `- Potentially resolvable by business-rule approval: ${summary.potentiallyResolvableByBusinessRuleApproval}`,
    `- Remaining after HIGH only: ${summary.numberRemainingAfterHighRules}`,
    `- Remaining after HIGH + business approval: ${summary.numberRemainingAfterHighAndBusinessApproval}`,
    "",
    "## Top Candidate Rules",
    "",
    "| Token/Regex | Classification | Vendor | Review Items | Evidence | Reason |",
    "| --- | --- | --- | ---: | --- | --- |",
    ...rules.slice(0, 80).map((rule) => {
      const evidence = rule.evidenceVendorCounts
        .slice(0, 3)
        .map((item) => `${item.vendorId} ${item.count}`)
        .join("; ");
      return `| \`${rule.regex}\` | ${rule.classification} | ${rule.candidateVendorId} ${rule.candidateVendorName} | ${rule.affectedReviewItems} | ${evidence} | ${rule.reason.replace(/\|/g, "/")} |`;
    }),
    "",
    "## Notes",
    "",
    "- `HIGH` means the rule is strong enough to consider for automatic assignment, subject to explicit approval before mutation work.",
    "- `BUSINESS_RULE_APPROVAL` means existing StockItem data is consistent, but the token is a brand/product-line/distributor relationship that should be explicitly approved.",
    "- `AMBIGUOUS` means multiple active vendors or StockItem evidence conflicts; do not auto-assign.",
    "- All evidence came from read-only StockItem GETs with `VendorDetails` expanded and the existing vendor master artifact.",
    "",
  ].join("\n");

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "vendor-rule-summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(OUT_DIR, "vendor-rule-candidates.json"), JSON.stringify(rules, null, 2));
  await writeFile(
    path.join(OUT_DIR, "vendor-rule-candidates.csv"),
    toCsv(reportRows, Object.keys(reportRows[0] || {}))
  );
  await writeFile(
    path.join(OUT_DIR, "active-vendors.csv"),
    toCsv(
      active.map((vendor) => ({
        VendorID: vendor.vendorId,
        VendorName: vendor.vendorName,
        LegalName: vendor.legalName,
        Status: vendor.status,
        VendorClass: vendor.vendorClass,
        NormalizedVendorName: normalizeText(vendor.vendorName),
        NormalizedLegalName: normalizeText(vendor.legalName),
      })),
      [
        "VendorID",
        "VendorName",
        "LegalName",
        "Status",
        "VendorClass",
        "NormalizedVendorName",
        "NormalizedLegalName",
      ]
    )
  );
  await writeFile(path.join(OUT_DIR, "vendor-rule-report.md"), markdown);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
