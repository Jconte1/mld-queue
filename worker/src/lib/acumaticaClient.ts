import { env } from "./env";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
};

function quoteForOData(value: string): string {
  return value.replace(/'/g, "''");
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

  async getToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > Date.now()) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: this.refreshToken ? "refresh_token" : "password",
      client_id: env.acumaticaClientId,
      client_secret: env.acumaticaClientSecret
    });

    if (this.refreshToken) {
      body.append("refresh_token", this.refreshToken);
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
    if (!response.ok) {
      throw new Error(`Token request failed: ${data.error || data.error_description || "unknown"}`);
    }

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token ?? null;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {})
      }
    });

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

  async createOpportunity(payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this.entityBase}/${env.acumaticaOpportunityEntity}`;
    return this.request<unknown>(url, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
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

  async fetchOrderHeaderByOrderNbr(orderNbr: string): Promise<Record<string, unknown> | null> {
    const params = new URLSearchParams();
    params.set("$filter", `OrderNbr eq '${quoteForOData(orderNbr)}'`);
    params.set("$select", "OrderNbr,Status,LocationID,ShipVia,CustomerID,LastModified");
    params.set("$top", "1");
    const url = `${this.readEntityBase}/SalesOrder?${params.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
    return rows[0] || null;
  }

  async verifyCustomerByZip(customerId: string, zip5: string): Promise<boolean> {
    const params = new URLSearchParams();
    params.set("$top", "1");
    params.set(
      "$filter",
      `CustomerID eq '${quoteForOData(customerId)}' and Zip5 eq '${quoteForOData(zip5)}'`
    );
    const url = `${this.readEntityBase}/Customer?${params.toString()}`;
    const rows = toRows(await this.request<unknown>(url, { method: "GET" }));
    return rows.length > 0;
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
    const custom = "Document.AttributeBUYERGROUP";

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
          "Status ne 'Awaiting Payment'",
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
    const custom = "Document.AttributeBUYERGROUP";
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
  return [];
}

export function isTransientError(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  if (status && (status === 429 || status >= 500)) {
    return true;
  }

  const msg = error instanceof Error ? error.message : String(error);
  return ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "timeout"].some((token) => msg.includes(token));
}
