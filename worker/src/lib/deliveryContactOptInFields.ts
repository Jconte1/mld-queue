export const DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS =
  "Contact.AttributeCONTEXT,Contact.AttributeCONPHONE,Contact.AttributeCONEMAIL";

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
