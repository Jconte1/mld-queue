import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDeliveryContactOptInAttributesAcumaticaPayload,
  normalizeDeliveryContactOptInAttributesPayload,
  processDeliveryContactOptInAttributesJob,
  type DeliveryContactOptInAttributeState,
  type DeliveryContactOptInAttributesAcumaticaClient,
} from "../src/lib/deliveryContactOptInAttributes";

const ROOT = join(process.cwd(), "..");

function assert(condition: unknown, message: string, failures: string[]) {
  if (!condition) failures.push(message);
}

function assertThrows(fn: () => unknown, message: string, failures: string[]) {
  try {
    fn();
    failures.push(message);
  } catch {
    return;
  }
}

function read(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function optInValue(value: boolean | null, exposed = true) {
  return { exposed, value };
}

function contactState(params: {
  contactId?: string | null;
  sms?: boolean | null;
  email?: boolean | null;
  phoneCall?: boolean | null;
  smsExposed?: boolean;
  emailExposed?: boolean;
  phoneCallExposed?: boolean;
}): DeliveryContactOptInAttributeState {
  return {
    contactId: params.contactId ?? "129387",
    smsOptIn: optInValue(params.sms ?? null, params.smsExposed ?? true),
    emailOptIn: optInValue(params.email ?? null, params.emailExposed ?? true),
    phoneCallOptIn: optInValue(params.phoneCall ?? null, params.phoneCallExposed ?? true),
  };
}

function fakeClient(params: {
  states: DeliveryContactOptInAttributeState[];
  verificationStates?: DeliveryContactOptInAttributeState[];
}) {
  const calls = {
    fetch: 0,
    put: 0,
    putPayload: null as Record<string, unknown> | null,
  };
  const client: DeliveryContactOptInAttributesAcumaticaClient = {
    fetchDeliveryContactOptInAttributeStates: async () => {
      calls.fetch += 1;
      return calls.fetch > 1 ? params.verificationStates ?? params.states : params.states;
    },
    putDeliveryContactOptInAttributes: async (payload) => {
      calls.put += 1;
      calls.putPayload = payload;
      return { status: 200, body: payload };
    },
  };

  return { client, calls };
}

async function main() {
  const failures: string[] = [];

  const normalized = normalizeDeliveryContactOptInAttributesPayload({
    contactId: " 129387 ",
    smsOptIn: false,
    source: " twilio_stop ",
    reason: " customer_sms_opt_out ",
  });
  assert(normalized.contactId === "129387", "contactId is trimmed", failures);
  assert(normalized.source === "twilio_stop", "source is trimmed", failures);
  assert(normalized.reason === "customer_sms_opt_out", "reason is trimmed", failures);
  assert(normalized.smsOptIn === false, "smsOptIn false is accepted", failures);
  assert(normalized.dryRun === true, "dryRun defaults true", failures);

  assertThrows(
    () =>
      normalizeDeliveryContactOptInAttributesPayload({
        contactId: "129387",
        smsOptIn: true,
        source: "twilio_stop",
        reason: "customer_sms_opt_out",
      }),
    "true opt-in payload values are rejected",
    failures
  );
  assertThrows(
    () =>
      normalizeDeliveryContactOptInAttributesPayload({
        contactId: "129387",
        source: "twilio_stop",
        reason: "customer_sms_opt_out",
      }),
    "payloads without target fields are rejected",
    failures
  );
  assertThrows(
    () =>
      normalizeDeliveryContactOptInAttributesPayload({
        contactId: " ",
        smsOptIn: false,
        source: "twilio_stop",
        reason: "customer_sms_opt_out",
      }),
    "blank contactId is rejected",
    failures
  );

  const acumaticaPayload = buildDeliveryContactOptInAttributesAcumaticaPayload(
    { contactId: "129387" },
    ["smsOptIn", "emailOptIn"]
  );
  const serializedPayload = JSON.stringify(acumaticaPayload);
  assert(serializedPayload.includes("\"ContactID\""), "payload includes ContactID", failures);
  assert(serializedPayload.includes("\"AttributeCONTEXT\""), "payload writes text opt-in field", failures);
  assert(serializedPayload.includes("\"AttributeCONEMAIL\""), "payload writes email opt-in field", failures);
  assert(!serializedPayload.includes("\"AttributeCONPHONE\""), "payload omits unrequested field", failures);
  assert(!serializedPayload.includes("DoNotEmail"), "payload does not include DoNotEmail", failures);
  assert(serializedPayload.includes("\"value\":false"), "payload writes false", failures);
  assert(!serializedPayload.includes("\"value\":true"), "payload never writes true", failures);

  const dry = fakeClient({ states: [contactState({ sms: true })] });
  const dryResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: true,
    },
    dry.client,
    {}
  );
  assert(dryResult.status === "dry_run", "payload dry-run returns dry_run", failures);
  assert(dry.calls.fetch === 0 && dry.calls.put === 0, "dry-run skips GET and PUT", failures);

  const envDry = fakeClient({ states: [contactState({ sms: true })] });
  const envDryResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: false,
    },
    envDry.client,
    { ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "true" }
  );
  assert(envDryResult.status === "dry_run", "env dry-run overrides payload", failures);
  assert(envDry.calls.fetch === 0 && envDry.calls.put === 0, "env dry-run skips reads and writes", failures);

  const disabled = fakeClient({ states: [contactState({ sms: true })] });
  const disabledResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: false,
    },
    disabled.client,
    {
      ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "false",
      ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED: "false",
    }
  );
  assert(disabledResult.status === "refused", "live disabled is refused", failures);
  assert(disabledResult.reason === "live_write_disabled", "live disabled reason is reported", failures);
  assert(disabled.calls.fetch === 0 && disabled.calls.put === 0, "live disabled skips Acumatica calls", failures);

  const allowlist = fakeClient({ states: [contactState({ sms: true })] });
  const allowlistResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: false,
    },
    allowlist.client,
    {
      ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "false",
      ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED: "true",
      ACUMATICA_CONTACT_OPT_IN_ALLOWED_CONTACT_ID: "999999",
    }
  );
  assert(allowlistResult.status === "refused", "allowlist mismatch is refused", failures);
  assert(allowlistResult.reason === "contact_not_allowlisted", "allowlist reason is reported", failures);
  assert(allowlist.calls.fetch === 0 && allowlist.calls.put === 0, "allowlist mismatch skips Acumatica calls", failures);

  const missingField = fakeClient({
    states: [contactState({ sms: null, smsExposed: false })],
  });
  const missingFieldResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: false,
    },
    missingField.client,
    {
      ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "false",
      ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED: "true",
    }
  );
  assert(missingFieldResult.status === "failed", "missing custom field fails", failures);
  assert(
    missingFieldResult.reason === "contact_opt_in_field_not_exposed",
    "missing custom field reason is descriptive",
    failures
  );
  assert(missingField.calls.put === 0, "missing custom field does not PUT", failures);

  const already = fakeClient({ states: [contactState({ sms: false })] });
  const alreadyResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: false,
    },
    already.client,
    {
      ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "false",
      ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED: "true",
    }
  );
  assert(alreadyResult.status === "already_false", "already false is idempotent", failures);
  assert(already.calls.fetch === 1 && already.calls.put === 0, "already false performs one read and no PUT", failures);

  const write = fakeClient({
    states: [contactState({ sms: true, email: null })],
    verificationStates: [contactState({ sms: false, email: false })],
  });
  const writeResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      emailOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: false,
    },
    write.client,
    {
      ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "false",
      ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED: "true",
    }
  );
  assert(writeResult.status === "written", "true/null exposed values write false and verify", failures);
  assert(write.calls.fetch === 2 && write.calls.put === 1, "write path reads, puts, verifies", failures);
  assert(
    !JSON.stringify(write.calls.putPayload).includes("\"value\":true"),
    "write payload contains no true values",
    failures
  );

  const partial = fakeClient({
    states: [contactState({ sms: false, email: true })],
    verificationStates: [contactState({ sms: false, email: false })],
  });
  await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      emailOptIn: false,
      source: "email_unsubscribe",
      reason: "customer_email_opt_out",
      dryRun: false,
    },
    partial.client,
    {
      ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "false",
      ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED: "true",
    }
  );
  const partialPayload = JSON.stringify(partial.calls.putPayload);
  assert(
    !partialPayload.includes("\"AttributeCONTEXT\"") &&
      partialPayload.includes("\"AttributeCONEMAIL\""),
    "live write includes only changed/provided attributes",
    failures
  );

  const verifyFail = fakeClient({
    states: [contactState({ sms: true })],
    verificationStates: [contactState({ sms: true })],
  });
  const verifyFailResult = await processDeliveryContactOptInAttributesJob(
    {
      contactId: "129387",
      smsOptIn: false,
      source: "twilio_stop",
      reason: "customer_sms_opt_out",
      dryRun: false,
    },
    verifyFail.client,
    {
      ACUMATICA_CONTACT_OPT_IN_DRY_RUN: "false",
      ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED: "true",
    }
  );
  assert(verifyFailResult.status === "failed", "verification failure fails safely", failures);
  assert(verifyFailResult.reason === "verification_failed", "verification failure reason is reported", failures);

  const acumaticaClient = read("worker/src/lib/acumaticaClient.ts");
  const contactOptInFields = read("worker/src/lib/deliveryContactOptInFields.ts");
  const worker = read("worker/src/worker.ts");
  const route = read("gateway/src/app/api/erp/jobs/delivery/contact-opt-in-attributes/route.ts");
  const schema = read("prisma/schema.prisma");

  assert(
    acumaticaClient.includes("ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED") ||
      acumaticaClient.includes("ACUMATICA_CONTACT_OPT_IN_WRITE_ENDPOINT_NAME"),
    "Acumatica client uses Contact opt-in writeback env controls",
    failures
  );
  assert(
    contactOptInFields.includes("Contact.AttributeCONTEXT,Contact.AttributeCONPHONE,Contact.AttributeCONEMAIL"),
    "Acumatica read path requests Contact opt-in custom fields",
    failures
  );
  assert(
    worker.includes("ERP_UPDATE_DELIVERY_CONTACT_OPT_IN_ATTRIBUTES"),
    "worker dispatches the Contact opt-in attribute job",
    failures
  );
  assert(
    route.includes("z.literal(false)") &&
      route.includes("ERP_UPDATE_DELIVERY_CONTACT_OPT_IN_ATTRIBUTES"),
    "gateway route validates false-only and enqueues the job type",
    failures
  );
  assert(
    schema.includes("ERP_UPDATE_DELIVERY_CONTACT_OPT_IN_ATTRIBUTES"),
    "Prisma JobType includes the Contact opt-in attribute job",
    failures
  );
  assert(
    !read("worker/src/lib/deliveryContactOptInAttributes.ts").includes("DoNotEmail"),
    "worker processor does not use DoNotEmail",
    failures
  );

  if (failures.length > 0) {
    console.error("Delivery Contact opt-in writeback validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    "Delivery Contact opt-in writeback validation passed. No Acumatica GET, PUT, SMS, email, provider dispatch, ONEWEEKCON write, hold write, deployment, delivery date change, or order-line change was performed."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
