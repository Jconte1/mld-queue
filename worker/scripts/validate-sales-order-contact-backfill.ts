import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  processSalesOrderContactBackfillJob,
  salesOrderContactBackfillCandidate,
  type SalesOrderContactBackfillClient,
} from "../src/lib/salesOrderContactBackfill";

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string, failures: string[]): void {
  if (!condition) failures.push(message);
}

function order(overrides: {
  phone?: string | null;
  email?: string | null;
  contactId?: string | null;
  deliveryContactId?: string | null;
  hold?: boolean;
} = {}): JsonRecord {
  return {
    OrderType: { value: "SO" },
    OrderNbr: { value: "SO38056" },
    Status: { value: "Open" },
    Hold: { value: overrides.hold ?? false },
    CustomerID: { value: "BA0001318" },
    ContactID: { value: overrides.contactId ?? null },
    DeliveryContact: overrides.deliveryContactId ? { value: overrides.deliveryContactId } : {},
    custom: {
      Document: {
        AttributeOSCONTACT: { value: "conte" },
        AttributeSITENUMBER: { value: overrides.phone === undefined ? "801-833-5923" : overrides.phone },
        AttributeSMSOPTIN: { value: true },
        AttributeEMAILNOTY: { value: overrides.email === undefined ? null : overrides.email },
        AttributeEMAILOPTIN: { value: true },
      },
    },
  };
}

function fakeClient(params: { contacts?: JsonRecord[]; initialOrder?: JsonRecord; ignoreDeliveryContact?: boolean } = {}) {
  let currentOrder = params.initialOrder ?? order();
  const contacts = params.contacts ?? [];
  const calls = { contactPuts: [] as JsonRecord[], orderPuts: [] as JsonRecord[] };
  const client: SalesOrderContactBackfillClient = {
    fetchSalesOrderContactBackfillOrder: async () => currentOrder,
    fetchDeliveryContactsForBusinessAccount: async () => contacts,
    putDeliveryContact: async (payload) => {
      calls.contactPuts.push(payload);
      return { ContactID: { value: "194581" } };
    },
    putDeliverySalesOrder: async (payload) => {
      calls.orderPuts.push(payload);
      const hold = (payload.Hold as { value?: unknown } | undefined)?.value;
      const contactId = (payload.ContactID as { value?: unknown } | undefined)?.value;
      const deliveryContactId = (payload.DeliveryContact as { value?: unknown } | undefined)?.value;
      currentOrder = {
        ...currentOrder,
        ...(typeof hold === "boolean" ? { Hold: { value: hold } } : {}),
        ...(contactId !== undefined ? { ContactID: { value: String(contactId) } } : {}),
        ...(deliveryContactId !== undefined && !params.ignoreDeliveryContact ? { DeliveryContact: { value: String(deliveryContactId) } } : {}),
      };
      return null;
    },
  };
  return { client, calls };
}

async function main(): Promise<void> {
  const failures: string[] = [];

  const missingPhone = salesOrderContactBackfillCandidate(order({ phone: " " }));
  assert(!missingPhone.eligible, "blank SITENUMBER is ineligible", failures);
  assert("reason" in missingPhone && missingPhone.reason === "missing_site_number", "blank phone skip reason", failures);

  const preview = fakeClient();
  const previewResult = await processSalesOrderContactBackfillJob(
    { orderType: "SO", orderNumber: "SO38056", apply: false },
    preview.client
  );
  assert(previewResult.status === "preview", "preview result returned", failures);
  assert(previewResult.emailFallbackUsed === true, "blank email uses fallback", failures);
  assert(preview.calls.contactPuts.length === 0, "preview does not write contact", failures);
  assert(preview.calls.orderPuts.length === 0, "preview does not write order", failures);

  const apply = fakeClient();
  const applyResult = await processSalesOrderContactBackfillJob(
    { orderType: "SO", orderNumber: "SO38056", apply: true },
    apply.client
  );
  const serializedContact = JSON.stringify(apply.calls.contactPuts[0]);
  assert(applyResult.status === "completed", "apply completes", failures);
  assert(serializedContact.includes("NA@NA.com"), "contact payload uses default email", failures);
  assert(serializedContact.includes("AttributeCONPHONE"), "contact payload includes CONPHONE", failures);
  assert(serializedContact.includes("Opt-in"), "CONPHONE defaults Opt-in", failures);
  assert(apply.calls.orderPuts.length === 3, "apply holds, attaches, and restores", failures);
  assert(JSON.stringify(apply.calls.orderPuts[1].ContactID) === JSON.stringify(apply.calls.orderPuts[1].DeliveryContact), "same contact assigned to both fields", failures);
  assert(applyResult.deliveryContactId === applyResult.contactId && applyResult.contactAssignmentsVerified === true, "both assignments verified in result", failures);
  assert(previewResult.deliveryContactAction === "assign_primary_contact", "preview reports delivery assignment", failures);

  const existing = fakeClient({ initialOrder: order({ deliveryContactId: "999" }) });
  const existingResult = await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, existing.client);
  assert(existingResult.deliveryContactId === "999", "existing delivery contact preserved", failures);
  assert(existing.calls.orderPuts.every(put => !("DeliveryContact" in put)), "existing delivery assignment never overwritten", failures);

  const missingFieldOrder = order();
  delete missingFieldOrder.DeliveryContact;
  const missingField = fakeClient({ initialOrder: missingFieldOrder });
  const missingResult = await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, missingField.client);
  assert(missingResult.reason === "delivery_contact_field_not_exposed", "unmapped delivery field fails closed", failures);
  assert(missingField.calls.contactPuts.length === 0 && missingField.calls.orderPuts.length === 0, "unmapped endpoint causes no writes", failures);

  const ignored = fakeClient({ ignoreDeliveryContact: true });
  let ignoredRejected = false;
  try {
    await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, ignored.client);
  } catch (error) { ignoredRejected = String(error).includes("delivery_contact_attachment_verification_failed"); }
  assert(ignoredRejected, "HTTP success without persisted delivery contact is rejected", failures);
  assert(JSON.stringify(ignored.calls.orderPuts.at(-1)?.Hold) === '{"value":false}', "original hold restored after attachment failure", failures);

  const held = fakeClient({ initialOrder: order({ hold: true }), contacts: [{ ContactID: { value: "194581" }, Phone1: { value: "8018335923" } }] });
  const heldResult = await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, held.client);
  assert(heldResult.contactAction === "reuse" && heldResult.deliveryContactId === "194581", "reused contact fills both fields", failures);
  assert(held.calls.orderPuts.length === 1 && !("Hold" in held.calls.orderPuts[0]), "already-held order remains held", failures);

  const rerun = await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, apply.client);
  assert(rerun.reason === "contact_already_attached" && apply.calls.orderPuts.length === 3, "rerun skips completed order without writes", failures);

  const duplicate = fakeClient({
    contacts: [
      { ContactID: { value: "1" }, Phone1: { value: "8018335923" } },
      { ContactID: { value: "2" }, Phone1: { value: "(801) 833-5923" } },
    ],
  });
  let duplicateRejected = false;
  try {
    await processSalesOrderContactBackfillJob(
      { orderType: "SO", orderNumber: "SO38056", apply: true },
      duplicate.client
    );
  } catch (error) {
    duplicateRejected = String(error).includes("ambiguous_existing_contacts");
  }
  assert(duplicateRejected, "ambiguous phone matches fail closed", failures);
  assert(duplicate.calls.contactPuts.length === 0 && duplicate.calls.orderPuts.length === 0, "ambiguous match makes no writes", failures);

  const producer = readFileSync(join(process.cwd(), "scripts/run-sales-order-contact-backfill.ts"), "utf8");
  assert(producer.includes("ServiceBusClient"), "producer uses Service Bus", failures);
  assert(!producer.includes("AcumaticaClient"), "producer does not call Acumatica directly", failures);
  assert(producer.includes("ERP_BACKFILL_SALES_ORDER_CONTACTS_RUN"), "producer queues parent job", failures);

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    dualContactAssignmentValidated: true,
    existingDeliveryAssignmentPreserved: true,
    missingFieldAndIgnoredWriteRejected: true,
    providerCalls: 0,
    acumaticaCalls: 0,
    databaseWrites: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
