import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
  hasDeliveryContactOptInCustomFields,
  CURRENT_DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
  normalizeDeliveryContactOptInRow,
  deliveryContactOptInWritePayload,
} from "../src/lib/deliveryContactOptInFields";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function assertIncludes(source: string, expected: string, message: string) {
  assert(source.includes(expected), `${message}: expected ${expected}`);
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const workerPackage = readFileSync(path.join(repoRoot, "worker/package.json"), "utf8");
  const rootPackage = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const acumaticaClient = readFileSync(
    path.join(repoRoot, "worker/src/lib/acumaticaClient.ts"),
    "utf8"
  );
  const workerSwitch = readFileSync(path.join(repoRoot, "worker/src/worker.ts"), "utf8");
  const route = readFileSync(
    path.join(repoRoot, "gateway/src/app/api/erp/jobs/delivery/contacts/route.ts"),
    "utf8"
  );

  const query = new URLSearchParams({
    $filter: "ContactID eq 123",
    $top: "1",
    $custom: DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
  });

  assert(
    query.get("$custom") === DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
    "Contact fetch query includes the exact Contact-qualified $custom value"
  );
  assert(
    !DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS.startsWith("AttributeCONTEXT"),
    "custom fields must not use unqualified Acumatica names"
  );
  assertIncludes(
    acumaticaClient,
    "$custom: DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS",
    "worker Contact fetch requests opt-in custom fields"
  );
  assertIncludes(
    acumaticaClient,
    "Contact?${query.toString()}",
    "worker Contact fetch keeps existing Contact endpoint query construction"
  );
  assertIncludes(
    workerSwitch,
    "rows: await acumaticaClient.fetchDeliveryContactByContactId(contactId)",
    "worker returns raw Contact rows from Acumatica client"
  );
  assertIncludes(route, "contactId: body.contactId.trim()", "gateway preserves trimmed contactId");
  assertIncludes(route, 'type: "ERP_GET_DELIVERY_CONTACT"', "gateway enqueues Contact lookup job");
  assertIncludes(
    workerPackage,
    "validate:delivery-contact-opt-in-fetch",
    "worker package validation script is registered"
  );
  assertIncludes(
    rootPackage,
    "validate:delivery-contact-opt-in-fetch",
    "root package validation script is registered"
  );

  assert(
    hasDeliveryContactOptInCustomFields({
      custom: {
        Contact: {
          AttributeCONTEXT: { type: "CustomStringField", value: "1.00000000" },
          AttributeCONPHONE: { type: "CustomStringField", value: "Opt-in" },
          AttributeCONEMAIL: { type: "CustomStringField", value: "Opt-out" },
        },
      },
    }),
    "mock selector Contact row preserves all three custom Contact fields"
  );
  assert(
    !hasDeliveryContactOptInCustomFields({
      custom: {
        Contact: {
          AttributeCONTEXT: { type: "CustomBooleanField", value: true },
          AttributeCONEMAIL: { type: "CustomBooleanField", value: null },
        },
      },
    }),
    "missing custom Contact field is detected"
  );

  const current = { ContactID: { value: 123 }, custom: { Contact: {
    AttributeTEXTCON: { type: "CustomStringField", value: "Opt-In" },
    AttributePHONECON: { type: "CustomStringField", value: "Opt-Out" },
    AttributeEMAILCON: { type: "CustomStringField", value: "" },
  } } };
  const normalized = normalizeDeliveryContactOptInRow(current);
  assert(normalized.custom.Contact.AttributeCONTEXT === current.custom.Contact.AttributeTEXTCON, "current text selector maps to canonical DTO");
  assert(normalized.custom.Contact.AttributeCONPHONE === current.custom.Contact.AttributePHONECON, "phone opt-out remains opt-out");
  assert(normalized.custom.Contact.AttributeCONEMAIL === current.custom.Contact.AttributeEMAILCON, "blank email remains blank, never forced opted-in");
  let failedClosed = false;
  try { normalizeDeliveryContactOptInRow({ ContactID: { value: 123 } }); } catch { failedClosed = true; }
  assert(failedClosed, "unexposed consent fails closed");
  const write = { ContactID: { value: "123" }, custom: { Contact: { AttributeCONTEXT: { type: "CustomStringField", value: "Opt-Out" } } } };
  const translated = deliveryContactOptInWritePayload(write, true);
  assert(JSON.stringify(translated).includes("AttributeTEXTCON") && !JSON.stringify(translated).includes("AttributeCONTEXT"), "opt-out write targets current physical attribute");
  assert(deliveryContactOptInWritePayload(write, false) === write, "legacy write contract remains supported");

  for (const name of ["AZURE_SERVICEBUS_CONNECTION_STRING", "SPECBOOKS_QUEUE_NAME", "DATABASE_URL",
    "ACUMATICA_BASE_URL", "ACUMATICA_CLIENT_ID", "ACUMATICA_CLIENT_SECRET", "ACUMATICA_USERNAME", "ACUMATICA_PASSWORD"]) {
    process.env[name] ??= "validation-only";
  }
  const { AcumaticaClient } = await import("../src/lib/acumaticaClient");
  const client = new AcumaticaClient();
  const mocked = client as unknown as { request: (url: string) => Promise<unknown> };
  const urls: string[] = [];
  mocked.request = async url => { urls.push(url); return [current]; };
  const rows = await client.fetchDeliveryContactByContactId("123");
  assert(rows.length === 1 && hasDeliveryContactOptInCustomFields(rows[0]), "real client returns normalized current consent");
  assert(new URL(urls[0], "https://erp.invalid").searchParams.get("$custom") === CURRENT_DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS, "client requests current ERP names first");
  const legacyRow = { ...current, custom: { Contact: normalized.custom.Contact } };
  let calls = 0;
  mocked.request = async () => {
    if (++calls === 1) throw Error("The column 'Contact_AttributeTEXTCON' is not found in the data set.");
    return [legacyRow];
  };
  await client.fetchDeliveryContactByContactId("123");
  assert(calls === 2, "known legacy schema receives bounded fallback");
  calls = 0;
  mocked.request = async () => { calls++; throw Error("ERP unavailable"); };
  try { await client.fetchDeliveryContactByContactId("123"); } catch { /* expected */ }
  assert(calls === 1, "network/auth/provider errors do not trigger misleading fallback");

  console.log(
    JSON.stringify(
      {
        customFields: DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
        contactQualifiedCustomPath: true,
        workerContactFetchWired: true,
        gatewayPassthroughWired: true,
        workerRawRowsPreserved: true,
        customContactShapePreserved: true,
        noAcumaticaWriteInvoked: true,
      },
      null,
      2
    )
  );
}

main().catch(error => { console.error(error); process.exitCode = 1; });
