export const DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS =
  "Contact.AttributeCONTEXT,Contact.AttributeCONPHONE,Contact.AttributeCONEMAIL";

export const CURRENT_DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS =
  "Contact.AttributeTEXTCON,Contact.AttributePHONECON,Contact.AttributeEMAILCON";

const CURRENT_BY_CANONICAL = {
  AttributeCONTEXT: "AttributeTEXTCON",
  AttributeCONPHONE: "AttributePHONECON",
  AttributeCONEMAIL: "AttributeEMAILCON",
} as const;

// Keep the delivery application's existing DTO while reading the current ERP attribute IDs.
export function normalizeDeliveryContactOptInRow(row: Record<string, unknown>) {
  const custom = isRecord(row.custom) ? row.custom : {};
  const source = isRecord(custom.Contact) ? custom.Contact : {};
  const contact = { ...source };
  for (const [canonical, current] of Object.entries(CURRENT_BY_CANONICAL)) {
    if (!(canonical in contact) && current in source) contact[canonical] = source[current];
  }
  const normalized = { ...row, custom: { ...custom, Contact: contact } };
  if (!hasDeliveryContactOptInCustomFields(normalized)) throw new Error("contact_opt_in_attributes_not_exposed");
  return normalized;
}

export function deliveryContactOptInWritePayload(payload: Record<string, unknown>, currentAttributes: boolean) {
  if (!currentAttributes) return payload;
  const custom = isRecord(payload.custom) ? payload.custom : {};
  const contact = { ...(isRecord(custom.Contact) ? custom.Contact : {}) };
  for (const [canonical, current] of Object.entries(CURRENT_BY_CANONICAL)) {
    if (canonical in contact) { contact[current] = contact[canonical]; delete contact[canonical]; }
  }
  return { ...payload, custom: { ...custom, Contact: contact } };
}

export const DELIVERY_CONTACT_OPT_IN_FIELD_PATHS = {
  smsText: ["custom", "Contact", "AttributeCONTEXT"] as const,
  phoneCall: ["custom", "Contact", "AttributeCONPHONE"] as const,
  email: ["custom", "Contact", "AttributeCONEMAIL"] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function hasDeliveryContactOptInCustomFields(row: unknown) {
  if (!isRecord(row)) return false;
  const custom = row.custom;
  if (!isRecord(custom)) return false;
  const contact = custom.Contact;
  if (!isRecord(contact)) return false;
  return (
    "AttributeCONTEXT" in contact &&
    "AttributeCONPHONE" in contact &&
    "AttributeCONEMAIL" in contact
  );
}
