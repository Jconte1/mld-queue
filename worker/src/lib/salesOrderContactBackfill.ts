export const SALES_ORDER_CONTACT_BACKFILL_STATUSES = [
  "Open",
  "Awaiting Payment",
  "Back Order",
  "On Hold but Approved",
] as const;

export const SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL = "NA@NA.com";

type JsonRecord = Record<string, unknown>;

export type SalesOrderContactBackfillClient = {
  fetchSalesOrderContactBackfillOrder(orderType: string, orderNumber: string): Promise<JsonRecord | null>;
  fetchDeliveryContactsForBusinessAccount(customerId: string): Promise<JsonRecord[]>;
  putDeliveryContact(payload: JsonRecord): Promise<unknown>;
  putDeliverySalesOrder(payload: JsonRecord): Promise<unknown>;
};

export type SalesOrderContactBackfillPayload = {
  orderType: string;
  orderNumber: string;
  apply: boolean;
};

type Candidate = {
  orderType: string;
  orderNumber: string;
  status: string;
  customerId: string;
  hold: boolean;
  lastName: string;
  phone: string;
  email: string;
  smsOptIn: boolean;
  emailOptIn: boolean;
};

function fieldValue(record: JsonRecord | null | undefined, name: string): unknown {
  const raw = record?.[name];
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    return (raw as { value?: unknown }).value;
  }
  return raw;
}

function stringField(record: JsonRecord | null | undefined, name: string): string | null {
  const value = fieldValue(record, name);
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function booleanField(record: JsonRecord | null | undefined, name: string): boolean {
  const value = fieldValue(record, name);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return ["true", "1", "yes", "y", "checked", "optin"].includes(normalized);
}

function customDocument(row: JsonRecord): JsonRecord {
  const custom = row.custom;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return {};
  const document = (custom as JsonRecord).Document;
  return document && typeof document === "object" && !Array.isArray(document)
    ? (document as JsonRecord)
    : {};
}

function rows(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter((row): row is JsonRecord => !!row && typeof row === "object");
  if (payload && typeof payload === "object") {
    const value = (payload as { value?: unknown }).value;
    if (Array.isArray(value)) return value.filter((row): row is JsonRecord => !!row && typeof row === "object");
    return [payload as JsonRecord];
  }
  return [];
}

function digits(value: string | null): string {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizedPayload(payload: Record<string, unknown> | undefined): SalesOrderContactBackfillPayload {
  const orderType = String(payload?.orderType ?? "").trim().toUpperCase();
  const orderNumber = String(payload?.orderNumber ?? "").trim().toUpperCase();
  if (!orderType || !orderNumber) throw new Error("orderType and orderNumber are required");
  return { orderType, orderNumber, apply: payload?.apply === true };
}

export function salesOrderContactBackfillCandidate(row: JsonRecord | null):
  | { eligible: true; candidate: Candidate }
  | { eligible: false; reason: string } {
  if (!row) return { eligible: false, reason: "order_not_found" };
  const custom = customDocument(row);
  const orderType = stringField(row, "OrderType")?.toUpperCase() ?? "";
  const orderNumber = stringField(row, "OrderNbr")?.toUpperCase() ?? "";
  const status = stringField(row, "Status") ?? "";
  const customerId = stringField(row, "CustomerID") ?? "";
  const contactId = stringField(row, "ContactID");
  const phone = digits(stringField(custom, "AttributeSITENUMBER"));

  if (!orderType || !orderNumber) return { eligible: false, reason: "missing_order_key" };
  if (!(SALES_ORDER_CONTACT_BACKFILL_STATUSES as readonly string[]).includes(status)) {
    return { eligible: false, reason: "status_not_allowed" };
  }
  if (contactId) return { eligible: false, reason: "contact_already_attached" };
  if (!customerId) return { eligible: false, reason: "missing_customer_id" };
  if (!phone) return { eligible: false, reason: "missing_site_number" };

  return {
    eligible: true,
    candidate: {
      orderType,
      orderNumber,
      status,
      customerId,
      hold: booleanField(row, "Hold"),
      lastName: stringField(custom, "AttributeOSCONTACT") ?? "Site Contact",
      phone,
      email: stringField(custom, "AttributeEMAILNOTY") ?? SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL,
      smsOptIn: booleanField(custom, "AttributeSMSOPTIN"),
      emailOptIn: booleanField(custom, "AttributeEMAILOPTIN"),
    },
  };
}

function contactPayload(candidate: Candidate, contactId?: string): JsonRecord {
  return {
    ...(contactId ? { ContactID: { value: contactId } } : {}),
    BusinessAccount: { value: candidate.customerId },
    LastName: { value: candidate.lastName },
    DisplayName: { value: candidate.lastName },
    Email: { value: candidate.email },
    Phone1: { value: candidate.phone },
    custom: {
      Contact: {
        AttributeCONTEXT: { type: "CustomStringField", value: candidate.smsOptIn ? "Opt-in" : "Opt-out" },
        AttributeCONEMAIL: { type: "CustomStringField", value: candidate.emailOptIn ? "Opt-in" : "Opt-out" },
        AttributeCONPHONE: { type: "CustomStringField", value: "Opt-in" },
      },
    },
  };
}

function orderPayload(candidate: Candidate, fields: JsonRecord): JsonRecord {
  return {
    OrderType: { value: candidate.orderType },
    OrderNbr: { value: candidate.orderNumber },
    ...fields,
  };
}

async function findMatchingContact(
  client: SalesOrderContactBackfillClient,
  candidate: Candidate
): Promise<string | null> {
  const contacts = await client.fetchDeliveryContactsForBusinessAccount(candidate.customerId);
  const matches = contacts.filter((contact) => digits(stringField(contact, "Phone1")) === candidate.phone);
  if (matches.length > 1) throw new Error("ambiguous_existing_contacts_for_customer_and_phone");
  if (matches.length === 0) return null;
  const contactId = stringField(matches[0], "ContactID");
  if (!contactId) throw new Error("matching_contact_missing_contact_id");
  return contactId;
}

async function verifyCreatedContact(
  client: SalesOrderContactBackfillClient,
  candidate: Candidate
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const contactId = await findMatchingContact(client, candidate);
    if (contactId) return contactId;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("created_contact_could_not_be_uniquely_verified");
}

async function attachContact(
  client: SalesOrderContactBackfillClient,
  candidate: Candidate,
  contactId: string
): Promise<void> {
  let temporaryHoldWritten = false;
  try {
    if (!candidate.hold) {
      await client.putDeliverySalesOrder(orderPayload(candidate, { Hold: { value: true } }));
      temporaryHoldWritten = true;
      const held = await client.fetchSalesOrderContactBackfillOrder(candidate.orderType, candidate.orderNumber);
      if (!held || !booleanField(held, "Hold")) throw new Error("temporary_hold_verification_failed");
    }

    const value: string | number = /^\d+$/.test(contactId) ? Number(contactId) : contactId;
    await client.putDeliverySalesOrder(orderPayload(candidate, { ContactID: { value } }));
    const attached = await client.fetchSalesOrderContactBackfillOrder(candidate.orderType, candidate.orderNumber);
    if (stringField(attached, "ContactID") !== contactId) throw new Error("contact_attachment_verification_failed");
  } finally {
    if (temporaryHoldWritten) {
      await client.putDeliverySalesOrder(orderPayload(candidate, { Hold: { value: false } }));
      const restored = await client.fetchSalesOrderContactBackfillOrder(candidate.orderType, candidate.orderNumber);
      if (!restored || booleanField(restored, "Hold")) throw new Error("original_hold_restore_failed");
    }
  }
}

export async function processSalesOrderContactBackfillJob(
  rawPayload: Record<string, unknown> | undefined,
  client: SalesOrderContactBackfillClient
): Promise<Record<string, unknown>> {
  const payload = normalizedPayload(rawPayload);
  const row = await client.fetchSalesOrderContactBackfillOrder(payload.orderType, payload.orderNumber);
  const evaluation = salesOrderContactBackfillCandidate(row);
  if ("reason" in evaluation) {
    return {
      status: "skipped",
      reason: evaluation.reason,
      orderType: payload.orderType,
      orderNumber: payload.orderNumber,
      apply: payload.apply,
    };
  }

  const candidate = evaluation.candidate;
  let contactId = await findMatchingContact(client, candidate);
  const contactAction = contactId ? "reuse" : "create";
  if (!payload.apply) {
    return {
      status: "preview",
      orderType: candidate.orderType,
      orderNumber: candidate.orderNumber,
      customerId: candidate.customerId,
      contactAction,
      existingContactId: contactId,
      emailFallbackUsed: candidate.email === SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL,
      smsOptIn: candidate.smsOptIn,
      emailOptIn: candidate.emailOptIn,
      phoneCallOptIn: true,
      writesPerformed: false,
    };
  }

  const response = await client.putDeliveryContact(contactPayload(candidate, contactId ?? undefined));
  if (!contactId) {
    contactId = rows(response).length ? stringField(rows(response)[0], "ContactID") : null;
    contactId = contactId ?? (await verifyCreatedContact(client, candidate));
  }
  await attachContact(client, candidate, contactId);

  return {
    status: "completed",
    orderType: candidate.orderType,
    orderNumber: candidate.orderNumber,
    customerId: candidate.customerId,
    contactId,
    contactAction,
    emailFallbackUsed: candidate.email === SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL,
    holdRestoredTo: candidate.hold,
    writesPerformed: true,
  };
}
