export const SALES_ORDER_CONTACT_BACKFILL_STATUSES = [
  "Open",
  "Awaiting Payment",
  "Back Order",
  "On Hold but Approved",
] as const;

export const SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL = "NA@NA.com";
export const SALES_ORDER_CONTACT_BACKFILL_EXCLUDED_ORDER_TYPES = ["QT", "RA"] as const;

export function salesOrderContactBackfillQueue(env: Record<string, string | undefined> = process.env): string {
  const queue = env.SPECBOOKS_QUEUE_NAME?.trim();
  if (!queue || queue.toLowerCase() === "mld-delivery-erp-jobs") {
    throw new Error("Contact backfill requires SPECBOOKS_QUEUE_NAME pointing to the primary worker queue, not the delivery queue");
  }
  return queue;
}

export function assertSalesOrderContactBackfillQueue(queue: string, env: Record<string, string | undefined> = process.env): void {
  if (queue !== salesOrderContactBackfillQueue(env)) {
    throw new Error("Contact backfill must run on the primary worker queue");
  }
}

type JsonRecord = Record<string, unknown>;

export type ContactCreationCheckpoint = {
  started: boolean;
  contactId: string | null;
  saveStarted(payload: JsonRecord): Promise<void>;
  saveContactId(contactId: string): Promise<void>;
};

export type SalesOrderContactBackfillClient = {
  fetchSalesOrderContactBackfillOrder(orderType: string, orderNumber: string): Promise<JsonRecord | null>;
  fetchDeliveryContactsForBusinessAccount(customerId: string): Promise<JsonRecord[]>;
  fetchSalesOrderContactBackfillContact(contactId: string): Promise<JsonRecord | null>;
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
  deliveryContactId: string | null;
  hold: boolean;
  displayName: string;
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
  if (typeof value === "object") return null;
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
  if ((SALES_ORDER_CONTACT_BACKFILL_EXCLUDED_ORDER_TYPES as readonly string[]).includes(orderType)) {
    return { eligible: false, reason: "order_type_excluded" };
  }
  if (!(SALES_ORDER_CONTACT_BACKFILL_STATUSES as readonly string[]).includes(status)) {
    return { eligible: false, reason: "status_not_allowed" };
  }
  if (contactId) return { eligible: false, reason: "contact_already_attached" };
  if (!Object.prototype.hasOwnProperty.call(row, "DeliveryContact")) {
    return { eligible: false, reason: "delivery_contact_field_not_exposed" };
  }
  if (!customerId) return { eligible: false, reason: "missing_customer_id" };
  if (!phone) return { eligible: false, reason: "missing_site_number" };

  return {
    eligible: true,
    candidate: {
      orderType,
      orderNumber,
      status,
      customerId,
      deliveryContactId: stringField(row, "DeliveryContact"),
      hold: booleanField(row, "Hold"),
      displayName: stringField(custom, "AttributeOSCONTACT") ?? "Site Contact",
      phone,
      email: stringField(custom, "AttributeEMAILNOTY") ?? SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL,
      smsOptIn: booleanField(custom, "AttributeSMSOPTIN"),
      emailOptIn: booleanField(custom, "AttributeEMAILOPTIN"),
    },
  };
}

export function salesOrderContactBackfillContactPayload(candidate: Candidate): JsonRecord {
  return {
    BusinessAccount: { value: candidate.customerId },
    FirstName: { value: candidate.displayName },
    LastName: { value: "__" },
    Email: { value: candidate.email },
    Phone1: { value: candidate.phone },
    custom: {
      Contact: {
        AttributeTEXTCON: { type: "CustomStringField", value: candidate.smsOptIn ? "Opt-In" : "Opt-Out" },
        AttributeEMAILCON: { type: "CustomStringField", value: candidate.emailOptIn ? "Opt-In" : "Opt-Out" },
        AttributePHONECON: { type: "CustomStringField", value: "Opt-In" },
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

async function attachContact(
  client: SalesOrderContactBackfillClient,
  candidate: Candidate,
  contactId: string,
  contactDisplayName: string
): Promise<void> {
  let temporaryHoldWritten = false;
  let assignmentsVerified = false;
  try {
    if (!candidate.hold) {
      await client.putDeliverySalesOrder(orderPayload(candidate, { Hold: { value: true } }));
      temporaryHoldWritten = true;
      const held = await client.fetchSalesOrderContactBackfillOrder(candidate.orderType, candidate.orderNumber);
      if (!held || !booleanField(held, "Hold")) throw new Error("temporary_hold_verification_failed");
    }

    const value: string | number = /^\d+$/.test(contactId) ? Number(contactId) : contactId;
    await client.putDeliverySalesOrder(orderPayload(candidate, {
      ContactID: { value },
      ...(candidate.deliveryContactId ? {} : { DeliveryContact: { value: contactDisplayName } }),
    }));
    const attached = await client.fetchSalesOrderContactBackfillOrder(candidate.orderType, candidate.orderNumber);
    if (stringField(attached, "ContactID") !== contactId) throw new Error("contact_attachment_verification_failed");
    if (stringField(attached, "DeliveryContact") !== (candidate.deliveryContactId ?? contactDisplayName)) {
      throw new Error("delivery_contact_attachment_verification_failed");
    }
    assignmentsVerified = true;
  } finally {
    if (temporaryHoldWritten) {
      await client.putDeliverySalesOrder(orderPayload(candidate, {
        Hold: { value: false },
        ContactID: { value: assignmentsVerified ? (/^\d+$/.test(contactId) ? Number(contactId) : contactId) : null },
        DeliveryContact: { value: candidate.deliveryContactId ?? (assignmentsVerified ? contactDisplayName : null) },
      }));
      const restored = await client.fetchSalesOrderContactBackfillOrder(candidate.orderType, candidate.orderNumber);
      if (!restored || booleanField(restored, "Hold")) throw new Error("original_hold_restore_failed");
      if (assignmentsVerified && (stringField(restored, "ContactID") !== contactId ||
          stringField(restored, "DeliveryContact") !== (candidate.deliveryContactId ?? contactDisplayName))) {
        throw new Error("contact_assignments_not_verified_after_hold_restore");
      }
    }
  }
}

export async function processSalesOrderContactBackfillJob(
  rawPayload: Record<string, unknown> | undefined,
  client: SalesOrderContactBackfillClient,
  checkpoint?: ContactCreationCheckpoint
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
  let contactId = checkpoint?.contactId ?? null;
  const contactAction = contactId ? "resume_created" : "create";
  if (!payload.apply) {
    return {
      status: "preview",
      orderType: candidate.orderType,
      orderNumber: candidate.orderNumber,
      customerId: candidate.customerId,
      contactAction,
      existingContactId: contactId,
      deliveryContactAction: candidate.deliveryContactId ? "preserve" : "assign_primary_contact",
      existingDeliveryContactId: candidate.deliveryContactId,
      emailFallbackUsed: candidate.email === SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL,
      smsOptIn: candidate.smsOptIn,
      emailOptIn: candidate.emailOptIn,
      phoneCallOptIn: true,
      writesPerformed: false,
    };
  }

  if (!checkpoint) throw new Error("contact_creation_checkpoint_required");
  if (!contactId) {
    if (checkpoint.started) throw new Error("contact_creation_outcome_unknown_manual_review_required");
    await checkpoint.saveStarted(salesOrderContactBackfillContactPayload(candidate));
    const response = await client.putDeliveryContact(salesOrderContactBackfillContactPayload(candidate));
    contactId = rows(response).length ? stringField(rows(response)[0], "ContactID") : null;
    if (!contactId) throw new Error("created_contact_id_missing_manual_review_required");
    await checkpoint.saveContactId(contactId);
  }
  const created = await client.fetchSalesOrderContactBackfillContact(contactId);
  const custom = (created?.custom as { Contact?: JsonRecord } | undefined)?.Contact;
  if (!created || stringField(created, "ContactID") !== contactId ||
      stringField(created, "BusinessAccount") !== candidate.customerId ||
      digits(stringField(created, "Phone1")) !== candidate.phone ||
      stringField(created, "Email")?.toLowerCase() !== candidate.email.toLowerCase() ||
      stringField(created, "FirstName") !== candidate.displayName || stringField(created, "LastName") !== "__" ||
      stringField(custom, "AttributeTEXTCON") !== (candidate.smsOptIn ? "Opt-In" : "Opt-Out") ||
      stringField(custom, "AttributeEMAILCON") !== (candidate.emailOptIn ? "Opt-In" : "Opt-Out") ||
      stringField(custom, "AttributePHONECON") !== "Opt-In") {
    throw new Error("created_contact_fields_verification_failed");
  }
  const contactDisplayName = stringField(created, "DisplayName");
  if (!contactDisplayName) throw new Error("created_contact_display_name_missing");
  if (!candidate.deliveryContactId) {
    const contacts = await client.fetchDeliveryContactsForBusinessAccount(candidate.customerId);
    const matches = contacts.filter((row) => stringField(row, "DisplayName") === contactDisplayName);
    if (matches.length !== 1 || stringField(matches[0], "ContactID") !== contactId) {
      throw new Error("delivery_contact_selector_ambiguous_manual_review_required");
    }
  }
  await attachContact(client, candidate, contactId, contactDisplayName);

  return {
    status: "completed",
    orderType: candidate.orderType,
    orderNumber: candidate.orderNumber,
    customerId: candidate.customerId,
    contactId,
    deliveryContactId: candidate.deliveryContactId ? null : contactId,
    deliveryContactValue: candidate.deliveryContactId ?? contactDisplayName,
    deliveryContactAction: candidate.deliveryContactId ? "preserved" : "assigned_primary_contact",
    contactAssignmentsVerified: true,
    contactFieldsVerified: true,
    contactAction,
    emailFallbackUsed: candidate.email === SALES_ORDER_CONTACT_BACKFILL_DEFAULT_EMAIL,
    holdRestoredTo: candidate.hold,
    writesPerformed: true,
  };
}
