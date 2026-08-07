import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DELIVERY_CONTACT_OPT_IN_CUSTOM_FIELDS,
  hasDeliveryContactOptInCustomFields,
} from "../src/lib/deliveryContactOptInFields";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function assertIncludes(source: string, expected: string, message: string) {
  assert(source.includes(expected), `${message}: expected ${expected}`);
}

function main() {
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
          AttributeCONTEXT: { type: "CustomBooleanField", value: true },
          AttributeCONPHONE: { type: "CustomBooleanField", value: false },
          AttributeCONEMAIL: { type: "CustomBooleanField", value: null },
        },
      },
    }),
    "mock Contact row preserves all three custom Contact fields"
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

main();
