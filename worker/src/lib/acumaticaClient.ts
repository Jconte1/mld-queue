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
