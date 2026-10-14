import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertSalesOrderContactBackfillQueue,
  salesOrderContactBackfillQueue,
  processSalesOrderContactBackfillJob as processBackfill,
  type ContactCreationCheckpoint,
  salesOrderContactBackfillCandidate,
  type SalesOrderContactBackfillClient,
} from "../src/lib/salesOrderContactBackfill";

type JsonRecord = Record<string, unknown>;

const checkpoints = new WeakMap<SalesOrderContactBackfillClient, ContactCreationCheckpoint>();
function processSalesOrderContactBackfillJob(payload: JsonRecord, client: SalesOrderContactBackfillClient) {
  let checkpoint = checkpoints.get(client);
  if (!checkpoint) {
    const state: ContactCreationCheckpoint = {
      started: false, contactId: null,
      saveStarted: async () => { state.started = true; },
      saveContactId: async (id) => { state.contactId = id; },
    };
    checkpoint = state;
    checkpoints.set(client, state);
  }
  return processBackfill(payload, client, checkpoint);
}

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
  assert(JSON.stringify(apply.calls.contactPuts[0].FirstName) === '{"value":"__"}', "new contact first name is double underscore", failures);
  assert(JSON.stringify(apply.calls.contactPuts[0].LastName) === '{"value":"site contact"}', "new contact last name is literal site contact", failures);
  assert(JSON.stringify(apply.calls.contactPuts[0].DisplayName) === '{"value":"conte"}', "display name still uses OSCONTACT", failures);
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
  assert(heldResult.contactAction === "create" && heldResult.deliveryContactId === "194581", "new contact fills both fields despite an existing match", failures);
  assert(JSON.stringify(held.calls.contactPuts[0].FirstName) === '{"value":"__"}' &&
    JSON.stringify(held.calls.contactPuts[0].LastName) === '{"value":"site contact"}', "new contact receives naming rule", failures);
  assert(!("ContactID" in held.calls.contactPuts[0]), "existing contact is never updated", failures);
  assert(held.calls.orderPuts.length === 1 && !("Hold" in held.calls.orderPuts[0]), "already-held order remains held", failures);

  const rerun = await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, apply.client);
  assert(rerun.reason === "contact_already_attached" && apply.calls.orderPuts.length === 3, "rerun skips completed order without writes", failures);

  const duplicate = fakeClient({
    contacts: [
      { ContactID: { value: "1" }, Phone1: { value: "8018335923" } },
      { ContactID: { value: "2" }, Phone1: { value: "(801) 833-5923" } },
    ],
  });
  const duplicateResult = await processSalesOrderContactBackfillJob(
      { orderType: "SO", orderNumber: "SO38056", apply: true },
      duplicate.client
    );
  assert(duplicateResult.status === "completed" && duplicate.calls.contactPuts.length === 1, "multiple phone matches do not prevent creating a new contact", failures);
  assert(!("ContactID" in duplicate.calls.contactPuts[0]), "multiple matches are not reused", failures);

  const uncertain = fakeClient();
  uncertain.client.putDeliveryContact = async (payload) => { uncertain.calls.contactPuts.push(payload); throw new Error("timeout"); };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, uncertain.client); }
    catch (error) { if (attempt === 1) assert(String(error).includes("outcome_unknown"), "unknown creation outcome requires review", failures); }
  }
  assert(uncertain.calls.contactPuts.length === 1, "uncertain creation is not retried blindly", failures);

  // The earlier ignored assignment has a persisted created ID but no complete attachment.
  const partial = fakeClient();
  const putOrder = partial.client.putDeliverySalesOrder;
  let failAttach = true;
  partial.client.putDeliverySalesOrder = async (payload) => {
    if (payload.ContactID && failAttach) { failAttach = false; throw new Error("attachment failure"); }
    return putOrder(payload);
  };
  try { await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, partial.client); } catch { /* Retry below. */ }
  const resumed = await processSalesOrderContactBackfillJob({ orderType: "SO", orderNumber: "SO38056", apply: true }, partial.client);
  assert(resumed.status === "completed" && resumed.contactAction === "resume_created" && partial.calls.contactPuts.length === 1, "attachment retry uses recorded new contact without duplicate creation", failures);

  const producer = readFileSync(join(process.cwd(), "scripts/run-sales-order-contact-backfill.ts"), "utf8");
  const clientSource = readFileSync(join(process.cwd(), "src/lib/acumaticaClient.ts"), "utf8");
  const lookupSource = clientSource.split("async fetchDeliveryContactsForBusinessAccount(")[1]?.split("async putDeliveryContact(")[0];
  assert(lookupSource && !lookupSource.includes("$custom") && lookupSource.includes("Phone1"), "contact matching fetch does not request unused opt-in custom fields", failures);
  const queueEnv = { SPECBOOKS_QUEUE_NAME: "specbooks-jobs", MLD_QUEUE_WORKER_QUEUE_NAME: "mld-delivery-erp-jobs" };
  assert(salesOrderContactBackfillQueue(queueEnv) === "specbooks-jobs", "backfill ignores delivery queue override", failures);
  assertSalesOrderContactBackfillQueue("specbooks-jobs", queueEnv);
  for (const invalid of [undefined, "", "mld-delivery-erp-jobs"]) {
    let rejected = false;
    try { salesOrderContactBackfillQueue({ SPECBOOKS_QUEUE_NAME: invalid }); } catch { rejected = true; }
    assert(rejected, "missing or delivery primary queue rejected", failures);
  }
  let wrongWorkerRejected = false;
  try { assertSalesOrderContactBackfillQueue("mld-delivery-erp-jobs", queueEnv); } catch { wrongWorkerRejected = true; }
  assert(wrongWorkerRejected, "delivery worker cannot execute contact backfill", failures);
  assert(producer.includes("const queueName = salesOrderContactBackfillQueue()") && producer.includes("createSender(queueName)"), "producer sends to primary queue", failures);
  const worker = readFileSync(join(process.cwd(), "src/worker.ts"), "utf8");
  for (const type of ["ERP_BACKFILL_SALES_ORDER_CONTACTS_RUN", "ERP_BACKFILL_SALES_ORDER_CONTACT"]) {
    assert(worker.includes(`case "${type}": {\n      assertSalesOrderContactBackfillQueue(env.queueName);`) ||
      worker.includes(`case "${type}": {\r\n      assertSalesOrderContactBackfillQueue(env.queueName);`), `${type} checks queue before execution`, failures);
  }
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
