import { withErpProtection } from "@/lib/erp/protection";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
};

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const ACUMATICA_BASE_URL = () => requireEnv("ACUMATICA_BASE_URL");
const ACUMATICA_CLIENT_ID = () => requireEnv("ACUMATICA_CLIENT_ID");
const ACUMATICA_CLIENT_SECRET = () => requireEnv("ACUMATICA_CLIENT_SECRET");
const ACUMATICA_USERNAME = () => requireEnv("ACUMATICA_USERNAME");
const ACUMATICA_PASSWORD = () => requireEnv("ACUMATICA_PASSWORD");
const ACUMATICA_ENDPOINT_NAME = () => process.env.ACUMATICA_ENDPOINT_NAME?.trim() || "CustomEndpoint";
const ACUMATICA_ENDPOINT_VERSION = () => process.env.ACUMATICA_ENDPOINT_VERSION?.trim() || "24.200.001";

function quoteForOData(value: string): string {
  return value.replace(/'/g, "''");
}

let accessToken: string | null = null;
let refreshToken: string | null = null;
let tokenExpiry: number | null = null;

async function getToken(): Promise<string> {
  if (accessToken && tokenExpiry && tokenExpiry > Date.now()) {
    return accessToken;
  }

  const body = new URLSearchParams({
    grant_type: refreshToken ? "refresh_token" : "password",
    client_id: ACUMATICA_CLIENT_ID(),
    client_secret: ACUMATICA_CLIENT_SECRET(),
  });

  if (refreshToken) {
    body.append("refresh_token", refreshToken);
  } else {
    body.append("username", ACUMATICA_USERNAME());
    body.append("password", ACUMATICA_PASSWORD());
    body.append("scope", "api offline_access");
  }

  const response = await fetch(`${ACUMATICA_BASE_URL()}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = (await response.json()) as TokenResponse;
  if (!response.ok) {
    const err = new Error(`Token request failed: ${data.error || data.error_description || "unknown"}`) as Error & {
      status?: number;
    };
    err.status = response.status;
    throw err;
  }

  accessToken = data.access_token;
  refreshToken = data.refresh_token ?? null;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return accessToken;
}

function entityBase(): string {
  return `${ACUMATICA_BASE_URL()}/entity/${ACUMATICA_ENDPOINT_NAME()}/${ACUMATICA_ENDPOINT_VERSION()}`;
}

async function fetchJson(url: string, endpoint: string): Promise<any> {
  return withErpProtection(endpoint, async () => {
    const token = await getToken();
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    const text = await response.text();
    if (!response.ok) {
      const err = new Error(text || `Acumatica request failed: ${response.status}`) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    if (!text) return [];
    return JSON.parse(text);
  });
}

function toRows(payload: any): Record<string, any>[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.value)) return payload.value;
  return [];
}

export async function verifyCustomerByZip(customerId: string, zip5: string): Promise<boolean> {
  const params = new URLSearchParams();
  params.set("$top", "1");
  params.set(
    "$filter",
    `CustomerID eq '${quoteForOData(customerId)}' and Zip5 eq '${quoteForOData(zip5)}'`
  );
  const url = `${entityBase()}/Customer?${params.toString()}`;
  const rows = toRows(await fetchJson(url, "customers.verify"));
  return rows.length > 0;
}

export async function fetchOrderReadyReportRows(): Promise<Record<string, any>[]> {
  const url =
    process.env.ACUMATICA_ORDER_READY_ODATA_URL?.trim() ||
    "https://acumatica.mld.com/OData/MLD/Ready%20for%20Willcall";
  const username = ACUMATICA_USERNAME();
  const password = ACUMATICA_PASSWORD();
  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  const payload = await withErpProtection("reports.order-ready", async () => {
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
      const err = new Error(text || `Order-ready OData request failed: ${response.status}`) as Error & {
        status?: number;
      };
      err.status = response.status;
      throw err;
    }

    return text ? JSON.parse(text) : [];
  });

  return toRows(payload);
}

export async function fetchOrderSummariesRows(
  baid: string,
  pageSize: number,
  maxPages: number,
  useOrderBy: boolean
): Promise<Record<string, any>[]> {
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

  const all: Record<string, any>[] = [];
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

    const rows = toRows(await fetchJson(`${entityBase()}/SalesOrder?${params.toString()}`, "orders.summaries"));
    all.push(...rows);
    if (rows.length < pageSize) break;
  }

  return all;
}

export async function fetchOrderSummariesDeltaRows(
  baid: string,
  since: string,
  pageSize: number,
  maxPages: number,
  useOrderBy: boolean
): Promise<Record<string, any>[]> {
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

  const all: Record<string, any>[] = [];
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

    const rows = toRows(
      await fetchJson(`${entityBase()}/SalesOrder?${params.toString()}`, "orders.summaries-delta")
    );
    all.push(...rows);
    if (rows.length < pageSize) break;
  }

  return all;
}

export async function fetchPaymentInfoRows(baid: string, orderNbrs: string[]): Promise<Record<string, any>[]> {
  if (!orderNbrs.length) return [];
  const select = ["OrderNbr", "OrderTotal", "UnpaidBalance", "Terms", "Status"].join(",");
  const ors = orderNbrs.map((n) => `OrderNbr eq '${quoteForOData(n)}'`).join(" or ");
  const filter = [`CustomerID eq '${quoteForOData(baid)}'`, `(${ors})`].join(" and ");
  const params = new URLSearchParams();
  params.set("$filter", filter);
  params.set("$select", select);
  params.set("$top", "500");
  return toRows(await fetchJson(`${entityBase()}/SalesOrder?${params.toString()}`, "orders.payment-info"));
}

export async function fetchInventoryDetailsRows(baid: string, orderNbrs: string[]): Promise<Record<string, any>[]> {
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
    "Canceled","Cancelled","On Hold","Pending Approval","Rejected","Pending Processing",
    "Credit Hold","Completed","Invoiced","Expired","Purchase Hold","Not Approved","Risk Hold",
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
  return toRows(await fetchJson(`${entityBase()}/SalesOrder?${params.toString()}`, "orders.inventory-details"));
}

export async function fetchAddressContactRows(
  baid: string,
  orderNbrs: string[],
  cutoffLiteral?: string | null,
  useOrderBy = false,
  pageSize = 500
): Promise<Record<string, any>[]> {
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
  return toRows(await fetchJson(`${entityBase()}/SalesOrder?${params.toString()}`, "orders.address-contact"));
}

export async function fetchOrderLastModifiedRaw(
  baid: string,
  orderNbr: string
): Promise<string | null> {
  const params = new URLSearchParams();
  params.set(
    "$filter",
    [`OrderNbr eq '${quoteForOData(orderNbr)}'`, `CustomerID eq '${quoteForOData(baid)}'`].join(" and ")
  );
  params.set("$select", "OrderNbr,LastModified");
  params.set("$top", "1");

  const rows = toRows(await fetchJson(`${entityBase()}/SalesOrder?${params.toString()}`, "orders.last-modified"));
  const row = rows[0] || null;
  return (
    row?.LastModified?.value ??
    row?.lastModified?.value ??
    row?.LastModified ??
    row?.lastModified ??
    null
  );
}

export async function fetchOrderHeaderByOrderNbr(orderNbr: string): Promise<Record<string, any> | null> {
  const params = new URLSearchParams();
  params.set("$filter", `OrderNbr eq '${quoteForOData(orderNbr)}'`);
  params.set("$select", "OrderNbr,Status,LocationID,ShipVia,CustomerID,LastModified");
  params.set("$top", "1");

  const rows = toRows(await fetchJson(`${entityBase()}/SalesOrder?${params.toString()}`, "orders.header"));
  return rows[0] || null;
}
