import { env } from "./env";
import { DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS } from "./deliveryContactOptInFields";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type TokenGrantType = "password" | "refresh_token";

type SalesOrderContactCountEndpoint = "read" | "delivery-sales-order";

type SalesOrderContactCountContactFilter = "non-null-and-not-empty" | "non-null";

export type SalesOrderContactCountResult = {
  count: number;
  method: "server-count" | "paged";
  endpoint: SalesOrderContactCountEndpoint;
  contactIdFilter: SalesOrderContactCountContactFilter;
  filter: string;
  statuses: string[];
  excludedOrderTypes: string[];
  pageSize: number;
  maxPages: number;
  pagesFetched: number;
  serverCountAttempted: boolean;
  serverCountReturned: boolean;
  pagedFallbackUsed: boolean;
  serverCountError: string | null;
};

class StockItemNotFoundError extends Error {
  status: number;
  inventoryId: string;

  constructor(inventoryId: string) {
    super(`Stock item not found: ${inventoryId}`);
    this.name = "StockItemNotFoundError";
    this.status = 404;
    this.inventoryId = inventoryId;
  }
}

const DEFAULT_DELIVERY_EXCLUDED_ORDER_TYPES = [
  "ED",
  "GB",
  "BH",
  "DS",
  "NH",
  "CH",
  "CM",
  "CR",
  "CS",
  "DR",
  "HC",
  "IN",
  "IS",
  "IV",
  "KS",
  "LU",
  "MM",
  "MO",
  "OA",
  "PR",
  "PT",
  "QT",
  "R1",
  "RA",
  "RC",
  "RM",
  "RR",
  "RY",
  "TB",
  "TR",
  "WB",
  "WP",
];

const DEFAULT_DELIVERY_ALLOWED_SHIP_VIA = [
  "DELIVERY SW",
  "DELIVERY SLC",
  "DELIVERY PROVO",
  "DELIVERY PLUMBI",
  "DELIVERY LAYTON",
  "DELIVERY KETCHU",
  "DELIVERY BOISE",
  "SE DELIVERY",
  "DELIVERY JACKSO",
  "DEL ST GEORGE",
  "DELIVERY",
];

const DEFAULT_DELIVERY_ALLOWED_STATUSES = [
  "Open",
  "Awaiting Payment",
  "Back Order",
  "On Hold but Approved",
  "Shipping",
  "Completed",
];

const DEFAULT_DELIVERY_SALES_ORDER_EXPAND = "Totals,Details/Allocations,ShipToAddress,TaxDetails";

const DEFAULT_SALES_ORDER_CONTACT_COUNT_STATUSES = [
  "Open",
  "Back Order",
  "Shipping",
  "On Hold but Approved",
];

const DEFAULT_SALES_ORDER_CONTACT_COUNT_EXCLUDED_ORDER_TYPES = ["QT"];

function isNoEntitySatisfiesConditionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("NoEntitySatisfiesTheConditionException") ||
    msg.includes("No entity satisfies the condition.")
  );
}

function quoteForOData(value: string): string {
  return value.replace(/'/g, "''");
}

function odataString(value: string): string {
  return `'${quoteForOData(value)}'`;
}

function toDateTimeOffset(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid delivery SalesOrder requestedOn date: ${value}`);
  }
  return date.toISOString();
}

function normalizedStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function tokenErrorMessage(data: TokenResponse): string {
  return data.error || data.error_description || "unknown";
}

function isInvalidGrant(data: TokenResponse): boolean {
  return [data.error, data.error_description].some(
    (value) => typeof value === "string" && value.includes("invalid_grant")
  );
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function salesOrderContactCountEndpoint(value: unknown): SalesOrderContactCountEndpoint {
  const normalized = String(value || "").trim().toLowerCase();
  if (["delivery", "delivery-sales-order", "deliverysalesorder"].includes(normalized)) {
    return "delivery-sales-order";
  }
  return "read";
}

function buildSalesOrderContactCountFilter(
  statuses: string[],
  excludedOrderTypes: string[],
  contactIdClause: string
): string {
  const clauses = [contactIdClause];

  if (statuses.length) {
    clauses.push(`(${statuses.map((status) => `Status eq ${odataString(status)}`).join(" or ")})`);
  }

  clauses.push(...excludedOrderTypes.map((orderType) => `OrderType ne ${odataString(orderType)}`));

  return clauses.join(" and ");
}

function readODataCount(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw =
    (payload as Record<string, unknown>)["@odata.count"] ??
    (payload as Record<string, unknown>)["odata.count"];
  const count = Number(raw);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function compactErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function mayBeContactIdEmptyStringTypeError(error: unknown): boolean {
  const normalized = compactErrorMessage(error).toLowerCase();
  return (
    normalized.includes("contactid") &&
    (normalized.includes("edm.int") ||
      normalized.includes("edm.decimal") ||
      normalized.includes("incompatible") ||
      normalized.includes("binary operator") ||
      normalized.includes("not valid") ||
      normalized.includes("invalid"))
  );
}

function getAcumaticaFieldValue(row: Record<string, unknown> | null, key: string): string | null {
  if (!row) return null;
  const raw = row[key];
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && "value" in raw) {
    const nested = (raw as { value?: unknown }).value;
    return nested == null ? null : String(nested);
  }
  return String(raw);
}

function getAcumaticaBooleanFieldValue(row: Record<string, unknown> | null, key: string): boolean | null {
  if (!row) return null;
  const raw = row[key];
  const value =
    typeof raw === "object" && raw !== null && "value" in raw
      ? (raw as { value?: unknown }).value
      : raw;
  return parseAcumaticaBooleanValue(value);
}

function parseAcumaticaBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
  }
  return null;
}

function readCustomDocumentAttribute(
  row: Record<string, unknown> | null,
  attributeName: string
): { exposed: boolean; value: string | null } {
  if (!row) return { exposed: false, value: null };

  const custom = row.custom;
  if (custom && typeof custom === "object" && "Document" in custom) {
    const document = (custom as { Document?: unknown }).Document;
    if (document && typeof document === "object" && attributeName in document) {
      const raw = (document as Record<string, unknown>)[attributeName];
      if (raw == null) return { exposed: true, value: null };
      if (typeof raw === "object" && raw !== null && "value" in raw) {
        const nested = (raw as { value?: unknown }).value;
        return { exposed: true, value: nested == null ? null : String(nested) };
      }
      return { exposed: true, value: String(raw) };
    }
  }

  const directKeys = [attributeName, `Document.${attributeName}`];
  for (const key of directKeys) {
    if (key in row) {
      return { exposed: true, value: getAcumaticaFieldValue(row, key) };
    }
  }

  return { exposed: false, value: null };
}

function readCustomDocumentBooleanAttribute(
  row: Record<string, unknown> | null,
  attributeName: string
): { exposed: boolean; value: boolean | null } {
  if (!row) return { exposed: false, value: null };

  const stringValue = readCustomDocumentAttribute(row, attributeName);
  if (stringValue.exposed) {
    return {
      exposed: true,
      value: parseAcumaticaBooleanValue(stringValue.value),
    };
  }

  return { exposed: false, value: null };
}

function readCustomContactAttribute(
  row: Record<string, unknown> | null,
  attributeName: string
): { exposed: boolean; value: string | null } {
  if (!row) return { exposed: false, value: null };

  const custom = row.custom;
  if (custom && typeof custom === "object" && "Contact" in custom) {
    const contact = (custom as { Contact?: unknown }).Contact;
    if (contact && typeof contact === "object" && attributeName in contact) {
      const raw = (contact as Record<string, unknown>)[attributeName];
      if (raw == null) return { exposed: true, value: null };
      if (typeof raw === "object" && raw !== null && "value" in raw) {
        const nested = (raw as { value?: unknown }).value;
        return { exposed: true, value: nested == null ? null : String(nested) };
      }
      return { exposed: true, value: String(raw) };
    }
  }

  const directKeys = [attributeName, `Contact.${attributeName}`];
  for (const key of directKeys) {
    if (key in row) {
      return { exposed: true, value: getAcumaticaFieldValue(row, key) };
    }
  }

  return { exposed: false, value: null };
}

function readCustomContactBooleanAttribute(
  row: Record<string, unknown> | null,
  attributeName: string
): { exposed: boolean; value: boolean | null } {
  if (!row) return { exposed: false, value: null };

  const stringValue = readCustomContactAttribute(row, attributeName);
  if (stringValue.exposed) {
    return {
      exposed: true,
      value: parseAcumaticaBooleanValue(stringValue.value),
    };
  }

  return { exposed: false, value: null };
}

function withAcumaticaFieldValue(original: unknown, value: string): unknown {
  if (typeof original === "object" && original !== null && "value" in original) {
    return {
      ...original,
      value
    };
  }

  return { value };
}

function stockItemMatchKey(value: string): string {
  return value.trim().toUpperCase().replace(/_/g, " ");
}

function getStockItemRowId(row: Record<string, unknown>): string | null {
  return (
    getAcumaticaFieldValue(row, "InventoryID") ??
    getAcumaticaFieldValue(row, "InventoryCD") ??
    getAcumaticaFieldValue(row, "id")
  );
}

function getStockItemDescriptionAlias(
  row: Record<string, unknown>,
  acumaticaId: string,
  requestedId: string
): string | null {
  const description = getAcumaticaFieldValue(row, "Description");
  if (!description) return null;

  const alias = description.trim().toUpperCase();
  if (!alias.includes("_")) return null;
  if (stockItemMatchKey(alias) !== stockItemMatchKey(acumaticaId)) return null;
  if (requestedId && stockItemMatchKey(alias) !== stockItemMatchKey(requestedId)) return null;

  return alias;
}

function normalizeStockItemRowForRequestedId(
  row: Record<string, unknown>,
  requestedInventoryId: string
): Record<string, unknown> {
  const requestedId = String(requestedInventoryId || "").trim().toUpperCase();
  if (!requestedId) return row;

  const acumaticaId = getStockItemRowId(row);
  if (!acumaticaId) return row;

  const requestedAlias =
    requestedId.includes("_") && stockItemMatchKey(acumaticaId) === stockItemMatchKey(requestedId)
      ? requestedId
      : null;
  const descriptionAlias = getStockItemDescriptionAlias(row, acumaticaId, requestedId);
  const normalizedId = requestedAlias ?? descriptionAlias;
  if (!normalizedId || normalizedId === acumaticaId) return row;

  return {
    ...row,
    InventoryID: withAcumaticaFieldValue(row.InventoryID, normalizedId),
    RequestedInventoryID: { value: requestedId },
    AcumaticaInventoryID: { value: acumaticaId },
    InventoryIDMatch: {
      value: requestedAlias ? "underscore_space_equivalence" : "description_underscore_space_equivalence"
    }
  };
}

export function normalizeStockItemPayloadForRequestedId(
  payload: unknown,
  requestedInventoryId: string
): unknown {
  const rows = toRows(payload);
  if (!rows.length) return payload;

  const normalizedRows = rows.map((row) => normalizeStockItemRowForRequestedId(row, requestedInventoryId));
  return Array.isArray(payload) ? normalizedRows : normalizedRows[0];
}

export class AcumaticaClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry: number | null = null;

  private get entityBase(): string {
    return `${env.acumaticaBaseUrl}/entity/${env.acumaticaEndpointName}/${env.acumaticaEndpointVersion}`;
  }

  private get readEntityBase(): string {
    const endpointName = process.env.ACUMATICA_READ_ENDPOINT_NAME?.trim() || "CustomEndpoint";
    const endpointVersion = process.env.ACUMATICA_READ_ENDPOINT_VERSION?.trim() || "24.200.001";
    return `${env.acumaticaBaseUrl}/entity/${endpointName}/${endpointVersion}`;
  }

  private get stockItemEntityBase(): string {
    return `${env.acumaticaBaseUrl}/entity/${env.acumaticaStockItemEndpointName}/${env.acumaticaStockItemEndpointVersion}`;
  }

  private get deliveryEntityBase(): string {
    return `${env.acumaticaBaseUrl}/entity/${env.acumaticaDeliveryEndpointName}/${env.acumaticaDeliveryEndpointVersion}`;
  }

  private get deliverySalesOrderEntityBase(): string {
    return `${env.acumaticaBaseUrl}/entity/${env.acumaticaDeliverySalesOrderEndpointName}/${env.acumaticaDeliverySalesOrderEndpointVersion}`;
  }

  private async requestToken(
    grantType: TokenGrantType,
    refreshToken?: string
  ): Promise<{ response: Response; data: TokenResponse }> {
    const body = new URLSearchParams({
      grant_type: grantType,
      client_id: env.acumaticaClientId,
      client_secret: env.acumaticaClientSecret
    });

    if (grantType === "refresh_token") {
      if (!refreshToken) {
        throw new Error("refreshToken is required for refresh_token grant");
      }
      body.append("refresh_token", refreshToken);
    } else {
      body.append("username", env.acumaticaUsername);
      body.append("password", env.acumaticaPassword);
      body.append("scope", "api offline_access");
    }

    const response = await fetch(`${env.acumaticaBaseUrl}/identity/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const data = (await response.json()) as TokenResponse;
    return { response, data };
  }

  private storeTokenResponse(data: TokenResponse): string {
    if (!data.access_token || typeof data.expires_in !== "number") {
      throw new Error(`Token request failed: ${tokenErrorMessage(data)}`);
    }

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token ?? null;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }

  async getToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > Date.now()) {
      return this.accessToken;
    }

    if (this.refreshToken) {
      const refreshAttempt = await this.requestToken("refresh_token", this.refreshToken);
      if (refreshAttempt.response.ok) {
        return this.storeTokenResponse(refreshAttempt.data);
      }

      if (!isInvalidGrant(refreshAttempt.data)) {
        throw new Error(`Token request failed: ${tokenErrorMessage(refreshAttempt.data)}`);
      }

      console.warn("[queue][acumatica][token] refresh token rejected; retrying password grant", {
        error: tokenErrorMessage(refreshAttempt.data)
      });
      this.accessToken = null;
      this.refreshToken = null;
      this.tokenExpiry = null;
    }

    const passwordAttempt = await this.requestToken("password");
    if (!passwordAttempt.response.ok) {
      throw new Error(`Token request failed: ${tokenErrorMessage(passwordAttempt.data)}`);
    }

    return this.storeTokenResponse(passwordAttempt.data);
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.acumaticaRequestTimeoutMs);
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {})
      }
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const body = await response.text();
      const err = new Error(`Acumatica request failed: ${response.status} ${response.statusText} ${body}`);
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    return (await response.json()) as T;
  }

  async getCustomer(customerId: string): Promise<unknown> {
    const filter = encodeURIComponent(`CustomerID eq '${quoteForOData(customerId)}'`);
    const url = `${this.entityBase}/${env.acumaticaCustomerEntity}?$filter=${filter}`;
    return this.request<unknown>(url, { method: "GET" });
  }

  async getOpportunity(opportunityId: string): Promise<unknown> {
    const filter = encodeURIComponent(`OpportunityID eq '${quoteForOData(opportunityId)}'`);
    const expand = env.acumaticaOpportunityExpand?.trim();
    const expandQuery = expand ? `&$expand=${encodeURIComponent(expand)}` : "";
    const url = `${this.entityBase}/${env.acumaticaOpportunityEntity}?$filter=${filter}${expandQuery}`;
    return this.request<unknown>(url, { method: "GET" });
  }

  async getContact(contactId: string): Promise<unknown> {
    const id = String(contactId || "").trim();
    if (!id) return [];

    // Preferred path: direct key lookup (matches known-good Acumatica behavior).
    const directUrl = `${this.entityBase}/${env.acumaticaContactEntity}/${encodeURIComponent(id)}`;
    try {
      return await this.request<unknown>(directUrl, { method: "GET" });
    } catch {
      // Fall through to filter-based variants.
    }

    // ContactID is commonly numeric; try numeric first, then quoted fallback.
    const numeric = Number(id);
    if (Number.isFinite(numeric)) {
      const numericFilter = encodeURIComponent(`ContactID eq ${Math.trunc(numeric)}`);
      const numericUrl = `${this.entityBase}/${env.acumaticaContactEntity}?$filter=${numericFilter}`;
      try {
        return await this.request<unknown>(numericUrl, { method: "GET" });
      } catch {
        // Try next fallback.
      }
    }

    const quotedFilter = encodeURIComponent(`ContactID eq '${quoteForOData(id)}'`);
    const quotedUrl = `${this.entityBase}/${env.acumaticaContactEntity}?$filter=${quotedFilter}`;
    return this.request<unknown>(quotedUrl, { method: "GET" });
  }

  async getStockItem(inventoryId: string): Promise<unknown> {
    const id = String(inventoryId || "").trim().toUpperCase();
    if (!id) return [];
    const url = `${this.stockItemEntityBase}/${env.acumaticaStockItemEntity}/${encodeURIComponent(id)}`;
    try {
      return await this.request<unknown>(url, { method: "GET" });
    } catch (error) {
      // Some inventory IDs (notably with slashes, e.g. DF60650CG/S/P) can fail
      // via key-path lookup with a 500 from Acumatica. Fall back to filter lookup.
      const byInventoryId = await this.getStockItemByFilter("InventoryID", id);
      if (byInventoryId) return byInventoryId;

      // Some endpoints expose the same key as InventoryCD instead of InventoryID.
      const byInventoryCd = await this.getStockItemByFilter("InventoryCD", id);
      if (byInventoryCd) return byInventoryCd;

      if (isNoEntitySatisfiesConditionError(error)) {
        throw new StockItemNotFoundError(id);
      }

      // If direct lookup failed and filter lookups returned nothing, treat as not found
      // so multi-item requests can still return the remaining successful rows.
      throw new StockItemNotFoundError(id);
    }
  }

  private async getStockItemByFilter(field: "InventoryID" | "InventoryCD", id: string): Promise<unknown | null> {
    const filter = encodeURIComponent(`${field} eq '${quoteForOData(id)}'`);
    const url = `${this.stockItemEntityBase}/${env.acumaticaStockItemEntity}?$filter=${filter}`;
    try {
      const payload = await this.request<unknown>(url, { method: "GET" });
      const rows = toRows(payload);
      if (!rows.length) return null;
      return rows;
    } catch (error) {
      if (isNoEntitySatisfiesConditionError(error)) {
        return null;
      }
      // Keep fallback resilient: treat unsupported field/lookups as no result.
      return null;
    }
  }

  async getStockItemForCleanup(inventoryId: string): Promise<unknown> {
    const id = String(inventoryId || "").trim().toUpperCase();
    if (!id) return [];

    const params = new URLSearchParams();
    params.set("$expand", "WarehouseDetails,VendorDetails");

    const directUrl = `${this.stockItemEntityBase}/${env.acumaticaStockItemEntity}/${encodeURIComponent(id)}?${params.toString()}`;
    try {
      return await this.request<unknown>(directUrl, { method: "GET" });
    } catch (error) {
      const byInventoryId = await this.getStockItemForCleanupByFilter("InventoryID", id);
      if (byInventoryId) return byInventoryId;

      const byInventoryCd = await this.getStockItemForCleanupByFilter("InventoryCD", id);
      if (byInventoryCd) return byInventoryCd;

      if (isNoEntitySatisfiesConditionError(error)) {
        throw new StockItemNotFoundError(id);
      }

      throw new StockItemNotFoundError(id);
    }
  }

  private async getStockItemForCleanupByFilter(
    field: "InventoryID" | "InventoryCD",
    id: string
  ): Promise<unknown | null> {
    const params = new URLSearchParams();
    params.set("$filter", `${field} eq '${quoteForOData(id)}'`);
    params.set("$expand", "WarehouseDetails,VendorDetails");
    params.set("$top", "1");

    const url = `${this.stockItemEntityBase}/${env.acumaticaStockItemEntity}?${params.toString()}`;
    try {
      const payload = await this.request<unknown>(url, { method: "GET" });
      const rows = toRows(payload);
      if (!rows.length) return null;
      return rows[0];
    } catch (error) {
      if (isNoEntitySatisfiesConditionError(error)) {
        return null;
      }
      return null;
    }
  }

  async getStockItems(inventoryIds: string[]): Promise<unknown> {
    const ids = Array.from(
      new Set(
        inventoryIds
          .map((v) => String(v || "").trim().toUpperCase())
          .filter(Boolean)
      )
    );
    if (!ids.length) return [];
    const allRows: Record<string, unknown>[] = [];
    const seen = new Set<string>();

    // Use per-item direct key lookup to avoid endpoint-specific filter field naming issues.
    for (const id of ids) {
      let payload: unknown;
      try {
        payload = await this.getStockItem(id);
      } catch (error) {
        // Multi-item lookup is used for existence checks. Missing items should
        // not fail the entire request; we return only found rows.
        if (error instanceof StockItemNotFoundError && ids.length > 1) {
          continue;
        }
        throw error;
      }
      const rows = toRows(payload);
      for (const row of rows) {
        const rowId = getStockItemRowId(row) ?? JSON.stringify(row);
        if (!seen.has(rowId)) {
          seen.add(rowId);
          allRows.push(normalizeStockItemRowForRequestedId(row, id));
        }
      }
    }

    return allRows;
  }

  async getItemClass(itemClassId: string): Promise<unknown> {
    const id = String(itemClassId || "").trim();
    if (!id) return [];

    // Some Acumatica endpoints expose ItemClass by direct key path, while others
    // require a filter and differ on key field names. Try both patterns.
    const directUrl = `${this.entityBase}/${env.acumaticaItemClassEntity}/${encodeURIComponent(id)}`;
    try {
      return await this.request<unknown>(directUrl, { method: "GET" });
    } catch {
      // Fall through to filter-based lookup variants.
    }

    const filterFields = ["ClassID", "ItemClassID", "ItemClassCD", "ItemClass"];
    for (const field of filterFields) {
      const filter = encodeURIComponent(`${field} eq '${quoteForOData(id)}'`);
      const url = `${this.entityBase}/${env.acumaticaItemClassEntity}?$filter=${filter}`;
      try {
        return await this.request<unknown>(url, { method: "GET" });
      } catch {
        // Try next candidate.
      }
    }

    // Bubble a clear error after all compatible query patterns fail.
    throw new Error(
      `Acumatica item-class lookup failed for '${id}' (tried direct key and filters: ClassID, ItemClassID, ItemClassCD, ItemClass)`
    );
  }

  async getItemClasses(): Promise<unknown> {
    const url = `${this.entityBase}/${env.acumaticaItemClassEntity}`;
    return this.request<unknown>(url, { method: "GET" });
  }

  async getVendor(vendorId: string): Promise<unknown> {
    const id = String(vendorId || "").trim().toUpperCase();
    if (!id) return [];

    const directUrl = `${this.entityBase}/${env.acumaticaVendorEntity}/${encodeURIComponent(id)}`;
    try {
      return await this.request<unknown>(directUrl, { method: "GET" });
    } catch {
      const params = new URLSearchParams();
      params.set("$filter", `VendorID eq '${quoteForOData(id)}'`);
      params.set("$top", "1");
      const url = `${this.entityBase}/${env.acumaticaVendorEntity}?${params.toString()}`;
      return this.request<unknown>(url, { method: "GET" });
    }
  }

  async createOpportunity(payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this.entityBase}/${env.acumaticaOpportunityEntity}`;
    return this.request<unknown>(url, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  }

  async createStockItem(payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this.stockItemEntityBase}/${env.acumaticaStockItemEntity}`;
    const result = await this.request<unknown>(url, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    const requestedInventoryId = getAcumaticaFieldValue(payload, "InventoryID");
    return requestedInventoryId
      ? normalizeStockItemPayloadForRequestedId(result, requestedInventoryId)
      : result;
  }

  async putStockItemForCleanup(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    const url = `${this.stockItemEntityBase}/${env.acumaticaStockItemEntity}`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const raw = await response.text();
    let parsedBody: unknown = raw;
    try {
      parsedBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsedBody = raw;
    }

    if (!response.ok) {
      const err = new Error(
        `StockItem cleanup write failed: ${response.status} ${response.statusText} ${
          raw || ""
        }`.trim()
      );
      const enriched = err as Error & {
        status?: number;
        responseBody?: unknown;
        responseText?: string;
      };
      enriched.status = response.status;
      enriched.responseBody = parsedBody;
      enriched.responseText = raw;
      throw err;
    }

    return { status: response.status, body: parsedBody };
  }

  async updateOpportunity(opportunityId: string, payload: Record<string, unknown>): Promise<unknown> {
    const withId = {
      OpportunityID: { value: opportunityId },
      ...payload
    };

    const url = `${this.entityBase}/${env.acumaticaOpportunityEntity}`;
    return this.request<unknown>(url, {
      method: "PUT",
      body: JSON.stringify(withId)
    });
  }

  async putSalesInvoice(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    const url = `${this.entityBase}/${env.acumaticaSalesInvoiceEntity}`;
    const locationValue =
      (payload.LocationID as { value?: unknown } | undefined)?.value ??
      (payload.locationID as { value?: unknown } | undefined)?.value ??
      null;
    console.info("[queue][acumatica][sales-invoice][request]", {
      url,
      hasLocationId: Boolean(locationValue),
      locationId: locationValue,
    });
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const raw = await response.text();
    let parsedBody: unknown = raw;
    try {
      parsedBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsedBody = raw;
    }

    if (!response.ok) {
      const err = new Error(
        `SalesInvoice PUT failed: ${response.status} ${response.statusText} ${raw || ""}`.trim()
      );
      const enriched = err as Error & {
        status?: number;
        responseBody?: unknown;
        responseText?: string;
      };
      enriched.status = response.status;
      enriched.responseBody = parsedBody;
      enriched.responseText = raw;
      throw err;
    }

    const responseLocation =
      (parsedBody as { LocationID?: { value?: unknown } } | null)?.LocationID?.value ?? null;
    console.info("[queue][acumatica][sales-invoice][response]", {
      url,
      status: response.status,
      responseLocationId: responseLocation,
    });

    return { status: response.status, body: parsedBody };
  }

  async putCustomerLocation(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    const url = `${this.entityBase}/CustomerLocation`;
    const locationId =
      (payload.LocationID as { value?: unknown } | undefined)?.value ??
      (payload.locationID as { value?: unknown } | undefined)?.value ??
      null;

    console.info("[queue][acumatica][customer-location][request]", {
      url,
      locationId,
    });

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const raw = await response.text();
    let parsedBody: unknown = raw;
    try {
      parsedBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsedBody = raw;
    }

    if (!response.ok) {
      const err = new Error(
        `CustomerLocation PUT failed: ${response.status} ${response.statusText} ${raw || ""}`.trim()
      );
      const enriched = err as Error & {
        status?: number;
        responseBody?: unknown;
        responseText?: string;
      };
      enriched.status = response.status;
      enriched.responseBody = parsedBody;
      enriched.responseText = raw;
      throw err;
    }

    const responseLocationId =
      (parsedBody as { LocationID?: { value?: unknown } } | null)?.LocationID?.value ?? null;
    console.info("[queue][acumatica][customer-location][response]", {
      url,
      status: response.status,
      responseLocationId,
    });

    return { status: response.status, body: parsedBody };
  }

  async fetchOrderHeaderByOrderNbr(orderNbr: string): Promise<Record<string, unknown> | null> {
    const params = new URLSearchParams();
    params.set("$filter", `OrderNbr eq '${quoteForOData(orderNbr)}'`);
    params.set("$select", "OrderNbr,Status,LocationID,ShipVia,CustomerID,LastModified");
    params.set("$top", "1");
    const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
    return rows[0] || null;
  }

  async countOpenSalesOrdersWithContact(params: {
    statuses?: unknown;
    excludedOrderTypes?: unknown;
    pageSize?: unknown;
    maxPages?: unknown;
    preferServerCount?: unknown;
    endpoint?: unknown;
  } = {}): Promise<SalesOrderContactCountResult> {
    const statuses = normalizedStringArray(
      params.statuses,
      DEFAULT_SALES_ORDER_CONTACT_COUNT_STATUSES
    );
    const excludedOrderTypes = normalizedStringArray(
      params.excludedOrderTypes,
      DEFAULT_SALES_ORDER_CONTACT_COUNT_EXCLUDED_ORDER_TYPES
    );
    const pageSize = positiveInteger(params.pageSize, 500, 1000);
    const maxPages = positiveInteger(params.maxPages, 10000, 100000);
    const preferServerCount = booleanOption(params.preferServerCount, true);
    const endpoint = salesOrderContactCountEndpoint(params.endpoint);
    const entityBase = endpoint === "delivery-sales-order" ? this.deliverySalesOrderEntityBase : this.readEntityBase;
    const contactFilters: Array<{
      mode: SalesOrderContactCountContactFilter;
      clause: string;
    }> = [
      { mode: "non-null-and-not-empty", clause: "ContactID ne null and ContactID ne ''" },
      { mode: "non-null", clause: "ContactID ne null" },
    ];

    let strictContactFilterError: unknown = null;
    for (const contactFilter of contactFilters) {
      const filter = buildSalesOrderContactCountFilter(
        statuses,
        excludedOrderTypes,
        contactFilter.clause
      );
      let serverCountError: string | null = null;

      try {
        if (preferServerCount) {
          try {
            const query = new URLSearchParams({
              $filter: filter,
              $select: "OrderNbr",
              $count: "true",
              $top: "0",
            });
            const payload = await this.request<unknown>(`${entityBase}/SalesOrder?${query.toString()}`, {
              method: "GET",
            });
            const serverCount = readODataCount(payload);
            if (serverCount !== null) {
              return {
                count: serverCount,
                method: "server-count",
                endpoint,
                contactIdFilter: contactFilter.mode,
                filter,
                statuses,
                excludedOrderTypes,
                pageSize,
                maxPages,
                pagesFetched: 0,
                serverCountAttempted: true,
                serverCountReturned: true,
                pagedFallbackUsed: false,
                serverCountError: null,
              };
            }
          } catch (error) {
            serverCountError = compactErrorMessage(error);
          }
        }

        let total = 0;
        let pagesFetched = 0;
        for (let page = 0; page < maxPages; page++) {
          const query = new URLSearchParams({
            $filter: filter,
            $select: "OrderNbr",
            $top: String(pageSize),
            $skip: String(page * pageSize),
          });
          const rows = toRows(
            await this.request<unknown>(`${entityBase}/SalesOrder?${query.toString()}`, {
              method: "GET",
            })
          );
          pagesFetched += 1;
          total += rows.length;
          if (rows.length < pageSize) {
            return {
              count: total,
              method: "paged",
              endpoint,
              contactIdFilter: contactFilter.mode,
              filter,
              statuses,
              excludedOrderTypes,
              pageSize,
              maxPages,
              pagesFetched,
              serverCountAttempted: preferServerCount,
              serverCountReturned: false,
              pagedFallbackUsed: true,
              serverCountError,
            };
          }
        }

        throw new Error(
          `SalesOrder count reached maxPages=${maxPages} before Acumatica returned a short page`
        );
      } catch (error) {
        if (contactFilter.mode === "non-null-and-not-empty" && mayBeContactIdEmptyStringTypeError(error)) {
          strictContactFilterError = error;
          continue;
        }
        throw error;
      }
    }

    throw strictContactFilterError instanceof Error
      ? strictContactFilterError
      : new Error("SalesOrder count failed for all ContactID filter variants");
  }

  async fetchDeliverySalesOrdersByLineRequestedOn(params: {
    requestedOn: string;
    excludedOrderTypes?: unknown;
    allowedShipVia?: unknown;
    allowedStatuses?: unknown;
  }): Promise<Record<string, unknown>[]> {
    const excludedOrderTypes = normalizedStringArray(
      params.excludedOrderTypes,
      DEFAULT_DELIVERY_EXCLUDED_ORDER_TYPES
    );
    const allowedShipVia = normalizedStringArray(
      params.allowedShipVia,
      DEFAULT_DELIVERY_ALLOWED_SHIP_VIA
    );
    const allowedStatuses = normalizedStringArray(
      params.allowedStatuses,
      DEFAULT_DELIVERY_ALLOWED_STATUSES
    );

    const clauses = [
      `LineRequestedOn eq datetimeoffset'${toDateTimeOffset(params.requestedOn)}'`,
      ...excludedOrderTypes.map((orderType) => `OrderType ne ${odataString(orderType)}`),
    ];

    if (allowedShipVia.length > 0) {
      clauses.push(`(${allowedShipVia.map((shipVia) => `ShipVia eq ${odataString(shipVia)}`).join(" or ")})`);
    }

    if (allowedStatuses.length > 0) {
      clauses.push(`(${allowedStatuses.map((status) => `Status eq ${odataString(status)}`).join(" or ")})`);
    }

    const query = new URLSearchParams({
      $filter: clauses.join(" and "),
      $select: "OrderNbr,OrderType,Status,ShipVia,LineRequestedOn",
    });
    const url = `${this.deliveryEntityBase}/SalesOrder?${query.toString()}`;

    return toRows(await this.request<unknown>(url, { method: "GET" }));
  }

  async fetchDeliverySalesOrderFull(
    orderNbr: string,
    orderType?: string | null
  ): Promise<Record<string, unknown>[]> {
    const clauses = [`OrderNbr eq ${odataString(orderNbr)}`];
    if (orderType) {
      clauses.push(`OrderType eq ${odataString(orderType)}`);
    }

    const query = new URLSearchParams({
      $filter: clauses.join(" and "),
      $expand: DEFAULT_DELIVERY_SALES_ORDER_EXPAND,
      $custom:
        "Document.AttributeBUYERGROUP,Document.AttributeCONFIRMVIA,Document.AttributeCONFIRMWTH,Document.AttributeSALESNEW,Document.AttributeONEWEEKCON",
    });
    const url = `${this.deliverySalesOrderEntityBase}/SalesOrder?${query.toString()}`;

    return toRows(await this.request<unknown>(url, { method: "GET" }));
  }

  async fetchDeliveryConfirmationAttributes(
    orderNbr: string,
    orderType?: string | null
  ): Promise<{
    orderType: string | null;
    orderNumber: string | null;
    confirmedVia: { exposed: boolean; value: string | null };
    confirmedWith: { exposed: boolean; value: string | null };
  } | null> {
    const clauses = [`OrderNbr eq ${odataString(orderNbr)}`];
    if (orderType) {
      clauses.push(`OrderType eq ${odataString(orderType)}`);
    }

    const query = new URLSearchParams({
      $filter: clauses.join(" and "),
      $select: "OrderNbr,OrderType",
      $custom: "Document.AttributeCONFIRMVIA,Document.AttributeCONFIRMWTH",
      $top: "1",
    });
    const url = `${this.deliverySalesOrderEntityBase}/SalesOrder?${query.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
    const row = rows[0] || null;
    if (!row) return null;

    return {
      orderType: getAcumaticaFieldValue(row, "OrderType"),
      orderNumber: getAcumaticaFieldValue(row, "OrderNbr"),
      confirmedVia: readCustomDocumentAttribute(row, "AttributeCONFIRMVIA"),
      confirmedWith: readCustomDocumentAttribute(row, "AttributeCONFIRMWTH"),
    };
  }

  async putDeliveryConfirmationAttributes(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    const endpointName =
      process.env.ACUMATICA_CONFIRMATION_WRITEBACK_ENDPOINT_NAME?.trim() ||
      env.acumaticaDeliverySalesOrderEndpointName;
    const endpointVersion =
      process.env.ACUMATICA_CONFIRMATION_WRITEBACK_ENDPOINT_VERSION?.trim() ||
      env.acumaticaDeliverySalesOrderEndpointVersion;
    const url = `${env.acumaticaBaseUrl}/entity/${endpointName}/${endpointVersion}/SalesOrder`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const raw = await response.text();
    let parsedBody: unknown = raw;
    try {
      parsedBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsedBody = raw;
    }

    if (!response.ok) {
      const err = new Error(
        `Delivery confirmation attribute writeback failed: ${response.status} ${response.statusText} ${
          raw || ""
        }`.trim()
      );
      const enriched = err as Error & {
        status?: number;
        responseBody?: unknown;
        responseText?: string;
      };
      enriched.status = response.status;
      enriched.responseBody = parsedBody;
      enriched.responseText = raw;
      throw err;
    }

    return { status: response.status, body: parsedBody };
  }

  async fetchDeliveryTenDayConfirmationStates(orderNbr: string, orderType: string): Promise<
    Array<{
      orderType: string | null;
      orderNumber: string | null;
      oneWeekConfirmed: boolean | null;
      oneWeekConfirmedExposed: boolean;
    }>
  > {
    const clauses = [`OrderNbr eq ${odataString(orderNbr)}`, `OrderType eq ${odataString(orderType)}`];
    const query = new URLSearchParams({
      $filter: clauses.join(" and "),
      $select: "OrderNbr,OrderType",
      $custom: "Document.AttributeONEWEEKCON",
      $top: "2",
    });
    const url = `${this.deliverySalesOrderEntityBase}/SalesOrder?${query.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));

    return rows.map((row) => {
      const oneWeekConfirmed = readCustomDocumentBooleanAttribute(row, "AttributeONEWEEKCON");
      return {
        orderType: getAcumaticaFieldValue(row, "OrderType"),
        orderNumber: getAcumaticaFieldValue(row, "OrderNbr"),
        oneWeekConfirmed: oneWeekConfirmed.value,
        oneWeekConfirmedExposed: oneWeekConfirmed.exposed,
      };
    });
  }

  async putDeliveryTenDayConfirmation(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    const url = `${this.deliverySalesOrderEntityBase}/SalesOrder`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const raw = await response.text();
    let parsedBody: unknown = raw;
    try {
      parsedBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsedBody = raw;
    }

    if (!response.ok) {
      const err = new Error(
        `Delivery ten-day confirmation write failed: ${response.status} ${response.statusText} ${
          raw || ""
        }`.trim()
      );
      const enriched = err as Error & {
        status?: number;
        responseBody?: unknown;
        responseText?: string;
      };
      enriched.status = response.status;
      enriched.responseBody = parsedBody;
      enriched.responseText = raw;
      throw err;
    }

    return { status: response.status, body: parsedBody };
  }

  async fetchDeliveryPrepaymentHoldStates(orderNbr: string, orderType: string): Promise<
    Array<{
      orderType: string | null;
      orderNumber: string | null;
      status: string | null;
      hold: boolean | null;
      holdExposed: boolean;
    }>
  > {
    const clauses = [`OrderNbr eq ${odataString(orderNbr)}`, `OrderType eq ${odataString(orderType)}`];
    const query = new URLSearchParams({
      $filter: clauses.join(" and "),
      $select: "OrderNbr,OrderType,Status,Hold",
      $top: "2",
    });
    const url = `${this.deliverySalesOrderEntityBase}/SalesOrder?${query.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));

    return rows.map((row) => ({
      orderType: getAcumaticaFieldValue(row, "OrderType"),
      orderNumber: getAcumaticaFieldValue(row, "OrderNbr"),
      status: getAcumaticaFieldValue(row, "Status"),
      hold: getAcumaticaBooleanFieldValue(row, "Hold"),
      holdExposed: row && Object.prototype.hasOwnProperty.call(row, "Hold"),
    }));
  }

  async putDeliveryPrepaymentHold(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    const url = `${this.deliverySalesOrderEntityBase}/SalesOrder`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const raw = await response.text();
    let parsedBody: unknown = raw;
    try {
      parsedBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsedBody = raw;
    }

    if (!response.ok) {
      const err = new Error(
        `Delivery prepayment hold write failed: ${response.status} ${response.statusText} ${
          raw || ""
        }`.trim()
      );
      const enriched = err as Error & {
        status?: number;
        responseBody?: unknown;
        responseText?: string;
      };
      enriched.status = response.status;
      enriched.responseBody = parsedBody;
      enriched.responseText = raw;
      throw err;
    }

    return { status: response.status, body: parsedBody };
  }

  async fetchDeliveryContactByContactId(contactId: string): Promise<Record<string, unknown>[]> {
    const id = String(contactId || "").trim();
    if (!id) return [];

    const contactIdValue = /^\d+$/.test(id) ? id : odataString(id);
    const query = new URLSearchParams({
      $filter: `ContactID eq ${contactIdValue}`,
      $top: "1",
      $custom: DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
    });
    const url = `${this.deliveryEntityBase}/Contact?${query.toString()}`;

    return toRows(await this.request<unknown>(url, { method: "GET" }));
  }

  async fetchDeliveryContactOptInAttributeStates(contactId: string): Promise<
    Array<{
      contactId: string | null;
      smsOptIn: { exposed: boolean; value: boolean | null };
      emailOptIn: { exposed: boolean; value: boolean | null };
      phoneCallOptIn: { exposed: boolean; value: boolean | null };
    }>
  > {
    const id = String(contactId || "").trim();
    if (!id) return [];

    const contactIdValue = /^\d+$/.test(id) ? id : odataString(id);
    const query = new URLSearchParams({
      $filter: `ContactID eq ${contactIdValue}`,
      $select: "ContactID",
      $top: "2",
      $custom: DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
    });
    const url = `${this.deliveryEntityBase}/Contact?${query.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));

    return rows.map((row) => ({
      contactId: getAcumaticaFieldValue(row, "ContactID"),
      smsOptIn: readCustomContactBooleanAttribute(row, "AttributeCONTEXT"),
      emailOptIn: readCustomContactBooleanAttribute(row, "AttributeCONEMAIL"),
      phoneCallOptIn: readCustomContactBooleanAttribute(row, "AttributeCONPHONE"),
    }));
  }

  async putDeliveryContactOptInAttributes(
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.getToken();
    const endpointName =
      process.env.ACUMATICA_CONTACT_OPT_IN_WRITE_ENDPOINT_NAME?.trim() ||
      env.acumaticaDeliveryEndpointName;
    const endpointVersion =
      process.env.ACUMATICA_CONTACT_OPT_IN_WRITE_ENDPOINT_VERSION?.trim() ||
      env.acumaticaDeliveryEndpointVersion;
    const url = `${env.acumaticaBaseUrl}/entity/${endpointName}/${endpointVersion}/Contact`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const raw = await response.text();
    let parsedBody: unknown = raw;
    try {
      parsedBody = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsedBody = raw;
    }

    if (!response.ok) {
      const err = new Error(
        `Delivery Contact opt-in attribute write failed: ${response.status} ${response.statusText} ${
          raw || ""
        }`.trim()
      );
      const enriched = err as Error & {
        status?: number;
        responseBody?: unknown;
        responseText?: string;
      };
      enriched.status = response.status;
      enriched.responseBody = parsedBody;
      enriched.responseText = raw;
      throw err;
    }

    return { status: response.status, body: parsedBody };
  }

  async verifyCustomerByZip(customerId: string, zip5: string): Promise<boolean> {
    const result = await this.verifyCustomerByZipWithDiagnostics(customerId, zip5);
    return result.matched;
  }

  async verifyCustomerByZipWithDiagnostics(
    customerId: string,
    zip5: string
  ): Promise<{ matched: boolean; candidateZip5: string[] }> {
    const params = new URLSearchParams();
    params.set("$top", "1");
    params.set(
      "$filter",
      `CustomerID eq '${quoteForOData(customerId)}' and Zip5 eq '${quoteForOData(zip5)}'`
    );
    const url = `${this.readEntityBase}/Customer?${params.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
    const matchedByZip5Filter = rows.length > 0;

    const diagParams = new URLSearchParams();
    diagParams.set("$top", "10");
    diagParams.set("$filter", `CustomerID eq '${quoteForOData(customerId)}'`);
    const diagUrl = `${this.readEntityBase}/Customer?${diagParams.toString()}`;
    const diagRows = toRows(await this.request<unknown>(diagUrl, { method: "GET" }));
    const candidateZip5 = Array.from(
      new Set(
        diagRows
          .map((row) =>
            (
              getAcumaticaFieldValue(row, "Zip5") ??
              getAcumaticaFieldValue(row, "ZipCode") ??
              getAcumaticaFieldValue(row, "PostalCode") ??
              getAcumaticaFieldValue(row, "Zip") ??
              ""
            )
              .replace(/\D/g, "")
              .slice(0, 5)
          )
          .filter((value) => value.length === 5)
      )
    );

    const matchedByCandidate = candidateZip5.includes(zip5);
    return { matched: matchedByZip5Filter || matchedByCandidate, candidateZip5 };
  }

  async fetchOrderReadyReportRows(): Promise<Record<string, unknown>[]> {
    const url =
      process.env.ACUMATICA_ORDER_READY_ODATA_URL?.trim() ||
      "https://acumatica.mld.com/OData/MLD/Ready%20for%20Willcall";
    const authHeader = `Basic ${Buffer.from(`${env.acumaticaUsername}:${env.acumaticaPassword}`).toString("base64")}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`Order-ready OData request failed: ${response.status} ${response.statusText} ${text}`);
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    return toRows(text ? JSON.parse(text) : []);
  }

  async fetchCloseoutInventoryReportRows(): Promise<Record<string, unknown>[]> {
    const url =
      process.env.ACUMATICA_CLOSEOUT_ODATA_URL?.trim() ||
      "https://acumatica.mld.com/OData/MLD/Closeout%20Inventory%20Counts";
    const authHeader = `Basic ${Buffer.from(`${env.acumaticaUsername}:${env.acumaticaPassword}`).toString("base64")}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const text = await response.text();
    if (!response.ok) {
      const err = new Error(
        `Closeout OData request failed: ${response.status} ${response.statusText} ${text}`
      );
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    return toRows(text ? JSON.parse(text) : []);
  }

  async fetchThankYouReportRows(): Promise<Record<string, unknown>[]> {
    const url =
      process.env.ACUMATICA_THANK_YOU_ODATA_URL?.trim() ||
      "https://acumatica.mld.com/OData/MLD/Thank%20You%20Notifications";
    const authHeader = `Basic ${Buffer.from(`${env.acumaticaUsername}:${env.acumaticaPassword}`).toString("base64")}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const text = await response.text();
    if (!response.ok) {
      const err = new Error(
        `Thank-you OData request failed: ${response.status} ${response.statusText} ${text}`
      );
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    return toRows(text ? JSON.parse(text) : []);
  }

  async markThankYouSent(orderNbr: string, orderType?: string | null): Promise<Record<string, unknown>> {
    const token = await this.getToken();
    const endpointName = process.env.ACUMATICA_THANK_YOU_WRITE_ENDPOINT_NAME?.trim() || "Default";
    const endpointVersion =
      process.env.ACUMATICA_THANK_YOU_WRITE_ENDPOINT_VERSION?.trim() || "24.200.001";
    const url = `${env.acumaticaBaseUrl}/entity/${endpointName}/${endpointVersion}/SalesOrder`;

    const payload: Record<string, unknown> = {
      OrderNbr: { value: orderNbr },
      custom: {
        Document: {
          AttributeTHANKYOU: { type: "CustomBooleanField", value: true },
        },
      },
    };
    if (orderType) {
      payload.OrderType = { value: orderType };
    }

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const text = await response.text();
    if (!response.ok) {
      const err = new Error(
        `Thank-you mark-sent failed: ${response.status} ${response.statusText} ${text}`
      );
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    try {
      return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async fetchOrderSummariesRows(
    baid: string,
    pageSize: number,
    maxPages: number,
    useOrderBy: boolean
  ): Promise<Record<string, unknown>[]> {
    const select = [
      "OrderNbr",
      "Status",
      "LocationID",
      "RequestedOn",
      "ShipVia",
      "JobName",
      "CustomerName",
      "DefaultSalesperson",
      "NoteID",
    ].join(",");
    const custom = "Document.AttributeBUYERGROUP,Document.AttributeSALESNEW";

    const now = new Date();
    now.setFullYear(now.getFullYear() - 1);
    const cutoff = now.toISOString();

    const excludedShipVia = [
      "DELIVERY SLC","DELIVERY SW","DIRECT SHIP","GROUND","MLD DROP SHIP","NEXT DAY AIR","RED LABEL",
      "2ND DAY AIR","3RD DAY AIR","COMMON CARRIER","BEST WAY","DEL ST GEORGE","DELIVERY","DELIVERY BOISE",
      "DELIVERY PROVO","DELIVERY JACKSO","DELIVERY KETCHU","DELIVERY LAYTON","DELIVERY PLUMBI","RUSH",
      "TRANS BOISE","TRANS JACKSON","TRANS PROVO","TRANS SLC","WAIVER PROVO","WAIVER SLC",
    ];

    const all: Record<string, unknown>[] = [];
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      params.set(
        "$filter",
        [
          `CustomerID eq '${quoteForOData(baid)}'`,
          `RequestedOn ge datetimeoffset'${cutoff}'`,
          "Status ne 'Canceled'",
          "Status ne 'On Hold'",
          "Status ne 'Pending Approval'",
          "Status ne 'Rejected'",
          "Status ne 'Pending Processing'",
          "Status ne 'Credit Hold'",
          "Status ne 'Completed'",
          "Status ne 'Invoiced'",
          "Status ne 'Expired'",
          "Status ne 'Purchase Hold'",
          "Status ne 'Not Approved'",
          "Status ne 'Risk Hold'",
          ...excludedShipVia.map((v) => `ShipVia ne '${v}'`),
        ].join(" and ")
      );
      params.set("$select", select);
      params.set("$custom", custom);
      if (useOrderBy) params.set("$orderby", "RequestedOn desc");
      params.set("$top", String(pageSize));
      params.set("$skip", String(page * pageSize));

      const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
      const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
      all.push(...rows);
      if (rows.length < pageSize) break;
    }

    return all;
  }

  async fetchOrderSummariesDeltaRows(
    baid: string,
    since: string,
    pageSize: number,
    maxPages: number,
    useOrderBy: boolean
  ): Promise<Record<string, unknown>[]> {
    const select = [
      "OrderNbr",
      "Status",
      "LocationID",
      "RequestedOn",
      "ShipVia",
      "JobName",
      "CustomerName",
      "DefaultSalesperson",
      "NoteID",
      "LastModified",
    ].join(",");
    const custom = "Document.AttributeBUYERGROUP,Document.AttributeSALESNEW";
    const normalizedSince = since.startsWith("datetimeoffset'") ? since : `datetimeoffset'${since}'`;

    const all: Record<string, unknown>[] = [];
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      params.set(
        "$filter",
        [`CustomerID eq '${quoteForOData(baid)}'`, `LastModified ge ${normalizedSince}`].join(" and ")
      );
      params.set("$select", select);
      params.set("$custom", custom);
      if (useOrderBy) params.set("$orderby", "LastModified desc");
      params.set("$top", String(pageSize));
      params.set("$skip", String(page * pageSize));

      const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
      const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
      all.push(...rows);
      if (rows.length < pageSize) break;
    }

    return all;
  }

  async fetchPaymentInfoRows(baid: string, orderNbrs: string[]): Promise<Record<string, unknown>[]> {
    if (!orderNbrs.length) return [];
    const select = ["OrderNbr", "OrderTotal", "UnpaidBalance", "Terms", "Status"].join(",");
    const ors = orderNbrs.map((n) => `OrderNbr eq '${quoteForOData(n)}'`).join(" or ");
    const filter = [`CustomerID eq '${quoteForOData(baid)}'`, `(${ors})`].join(" and ");
    const params = new URLSearchParams();
    params.set("$filter", filter);
    params.set("$select", select);
    params.set("$top", "500");
    const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
    return toRows(await this.request<unknown>(url, { method: "GET" }));
  }

  async fetchInventoryDetailsRows(baid: string, orderNbrs: string[]): Promise<Record<string, unknown>[]> {
    if (!orderNbrs.length) return [];
    const select = [
      "OrderNbr",
      "Details/InventoryID",
      "Details/LineDescription",
      "Details/LineType",
      "Details/UnitPrice",
      "Details/OpenQty",
      "Details/OrderQty",
      "Details/Amount",
      "Details/UsrETA",
      "Details/Here",
      "Details/Allocations/Allocated",
      "Details/Allocations/Qty",
      "Details/WarehouseID",
      "Details/TaxZone",
    ].join(",");

    const ors = orderNbrs.map((n) => `OrderNbr eq '${quoteForOData(n)}'`).join(" or ");
    const blockedStatuses = [
      "Canceled",
      "Cancelled",
      "On Hold",
      "Pending Approval",
      "Rejected",
      "Pending Processing",
      "Credit Hold",
      "Completed",
      "Invoiced",
      "Expired",
      "Purchase Hold",
      "Not Approved",
      "Risk Hold",
    ];
    const filter = [
      `CustomerID eq '${quoteForOData(baid)}'`,
      `(${ors})`,
      ...blockedStatuses.map((s) => `Status ne '${s}'`),
      "Status ne ''",
    ].join(" and ");

    const params = new URLSearchParams();
    params.set("$filter", filter);
    params.set("$select", select);
    params.set("$expand", "Details,Details/Allocations");
    params.set("$top", "500");
    const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
    return toRows(await this.request<unknown>(url, { method: "GET" }));
  }

  async fetchAddressContactRows(
    baid: string,
    orderNbrs: string[],
    cutoffLiteral?: string | null,
    useOrderBy = false,
    pageSize = 500
  ): Promise<Record<string, unknown>[]> {
    const select = [
      "OrderNbr",
      "AddressLine1",
      "AddressLine2",
      "City",
      "State",
      "PostalCode",
      "DeliveryEmail",
      "JobName",
      "ShipVia",
    ].join(",");
    const custom =
      "Document.AttributeSITENUMBER, Document.AttributeOSCONTACT, Document.AttributeCONFIRMVIA, Document.AttributeCONFIRMWTH";

    const baseParts = [`CustomerID eq '${quoteForOData(baid)}'`];
    if (cutoffLiteral) baseParts.push(`RequestedOn ge ${cutoffLiteral}`);
    if (orderNbrs.length) {
      const ors = orderNbrs.map((n) => `OrderNbr eq '${quoteForOData(n)}'`).join(" or ");
      baseParts.push(`(${ors})`);
    }

    const params = new URLSearchParams();
    params.set("$filter", baseParts.join(" and "));
    params.set("$select", select);
    params.set("$custom", custom);
    if (useOrderBy) params.set("$orderby", "OrderNbr desc");
    params.set("$top", String(pageSize));

    const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
    return toRows(await this.request<unknown>(url, { method: "GET" }));
  }

  async fetchOrderLastModifiedRaw(baid: string, orderNbr: string): Promise<string | null> {
    const params = new URLSearchParams();
    params.set(
      "$filter",
      [`OrderNbr eq '${quoteForOData(orderNbr)}'`, `CustomerID eq '${quoteForOData(baid)}'`].join(" and ")
    );
    params.set("$select", "OrderNbr,LastModified");
    params.set("$top", "1");

    const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
    const row = rows[0] || null;
    return (
      getAcumaticaFieldValue(row, "LastModified") ??
      getAcumaticaFieldValue(row, "lastModified")
    );
  }
}

function toRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  const maybeObj = payload as { value?: unknown } | null;
  if (maybeObj && Array.isArray(maybeObj.value)) {
    return maybeObj.value as Record<string, unknown>[];
  }
  if (maybeObj && typeof maybeObj === "object") {
    return [maybeObj as Record<string, unknown>];
  }
  return [];
}

export function isTransientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (
    msg.includes("NoEntitySatisfiesTheConditionException") ||
    msg.includes("No entity satisfies the condition.")
  ) {
    return false;
  }

  const status = (error as { status?: number } | undefined)?.status;
  if (status && (status === 429 || status >= 500)) {
    return true;
  }

  return ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "timeout"].some((token) => msg.includes(token));
}
