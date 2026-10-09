type JsonRecord = Record<string, unknown>;

export const US_STATE_CODES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ")
);
export const CUSTOMER_ADDRESS_FIELDS = ["AddressLine1", "AddressLine2", "City", "Country", "PostalCode"] as const;
export type CustomerAddressSnapshot = Record<(typeof CUSTOMER_ADDRESS_FIELDS)[number], string>;
export type CustomerStateCorrectionInput = {
  customerId: string;
  originalState: string;
  expectedState: string;
  address: CustomerAddressSnapshot;
  apply: boolean;
};
export type CustomerStateCorrectionClient = {
  fetchCustomerForStateCorrection(customerId: string): Promise<unknown>;
  putCustomerStateCorrection(payload: JsonRecord): Promise<unknown>;
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("customer_state_invalid_record");
  return value as JsonRecord;
}

function field(row: JsonRecord, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(row, key)) throw new Error(`customer_state_field_not_exposed:${key}`);
  const raw = row[key];
  const value = raw && typeof raw === "object" ? record(raw).value : raw;
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`customer_state_invalid_field:${key}`);
  return String(value).trim();
}

function normalized(value: string): string { return value.trim().replace(/\s+/g, " ").toUpperCase(); }

export function validateCustomerStateCorrectionInput(raw: unknown): CustomerStateCorrectionInput {
  const input = record(raw);
  if (typeof input.customerId !== "string" || !/^[A-Z0-9_-]{1,64}$/i.test(input.customerId.trim())) throw new Error("invalid_customer_id");
  if (typeof input.expectedState !== "string" || !US_STATE_CODES.has(input.expectedState.trim().toUpperCase())) throw new Error("invalid_expected_state");
  if (typeof input.originalState !== "string" || typeof input.apply !== "boolean") throw new Error("invalid_customer_state_payload");
  const address = record(input.address);
  for (const key of CUSTOMER_ADDRESS_FIELDS) if (typeof address[key] !== "string") throw new Error(`missing_source_address:${key}`);
  if (normalized(address.Country as string) !== "US") throw new Error("only_us_customer_addresses_supported");
  return { customerId: input.customerId.trim().toUpperCase(), originalState: input.originalState.trim(),
    expectedState: input.expectedState.trim().toUpperCase(), apply: input.apply,
    address: Object.fromEntries(CUSTOMER_ADDRESS_FIELDS.map(key => [key, (address[key] as string).trim()])) as CustomerAddressSnapshot };
}

function readCustomer(response: unknown, customerId: string) {
  const list = Array.isArray(response) ? response : record(response).value;
  if (!Array.isArray(list) || list.length !== 1) throw new Error("customer_state_customer_not_unique_or_missing");
  const customer = record(list[0]);
  if (normalized(field(customer, "CustomerID")) !== customerId) throw new Error("customer_state_customer_id_mismatch");
  if (typeof customer.id !== "string" || !/^[0-9a-f-]{36}$/i.test(customer.id)) throw new Error("customer_state_entity_id_missing");
  const contact = record(customer.MainContact);
  const address = record(contact.Address);
  const snapshot = Object.fromEntries(CUSTOMER_ADDRESS_FIELDS.map(key => [key, field(address, key)])) as CustomerAddressSnapshot;
  return { customer, contact, address, snapshot, state: field(address, "State") };
}

function childId(row: JsonRecord): JsonRecord {
  return typeof row.id === "string" && /^[0-9a-f-]{36}$/i.test(row.id) ? { id: row.id } : {};
}

/** A narrow read/compare/write/read operation; never accepts a caller-supplied ERP PUT body. */
export async function processCustomerStateCorrectionJob(raw: unknown, client: CustomerStateCorrectionClient) {
  const input = validateCustomerStateCorrectionInput(raw);
  const before = readCustomer(await client.fetchCustomerForStateCorrection(input.customerId), input.customerId);
  const base = { customerId: input.customerId, originalState: input.originalState, beforeState: before.state,
    expectedState: input.expectedState, field: "MainContact.Address.State", apply: input.apply };
  const changedFields = CUSTOMER_ADDRESS_FIELDS.filter(key => normalized(before.snapshot[key]) !== normalized(input.address[key]));
  if (changedFields.length) return { ...base, status: "skipped_address_changed", changedFields, writesPerformed: false };
  if (normalized(before.state) === input.expectedState) return { ...base, status: "already_correct", afterState: before.state, writesPerformed: false };
  if (normalized(before.state) !== normalized(input.originalState)) return { ...base, status: "skipped_state_changed", writesPerformed: false };
  if (!input.apply) return { ...base, status: "would_update", writesPerformed: false };

  await client.putCustomerStateCorrection({ id: before.customer.id,
    MainContact: { ...childId(before.contact), Address: { ...childId(before.address), State: { value: input.expectedState } } } });
  const after = readCustomer(await client.fetchCustomerForStateCorrection(input.customerId), input.customerId);
  if (after.customer.id !== before.customer.id || normalized(after.state) !== input.expectedState) throw new Error("customer_state_write_verification_failed");
  if (CUSTOMER_ADDRESS_FIELDS.some(key => normalized(after.snapshot[key]) !== normalized(before.snapshot[key]))) {
    throw new Error("customer_state_unexpected_address_change_after_write");
  }
  return { ...base, status: "updated", afterState: after.state, writesPerformed: true, verified: true };
}
