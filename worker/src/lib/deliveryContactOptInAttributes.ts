export const DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_JOB_TYPE =
  "ERP_UPDATE_DELIVERY_CONTACT_OPT_IN_ATTRIBUTES" as const;

export const DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_BY_FIELD = {
  smsOptIn: "AttributeCONTEXT",
  emailOptIn: "AttributeCONEMAIL",
  phoneCallOptIn: "AttributeCONPHONE",
} as const;

export const DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_PATH_BY_FIELD = {
  smsOptIn: "Contact.AttributeCONTEXT",
  emailOptIn: "Contact.AttributeCONEMAIL",
  phoneCallOptIn: "Contact.AttributeCONPHONE",
} as const;

export type DeliveryContactOptInField = keyof typeof DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_BY_FIELD;

export type DeliveryContactOptInAttributesPayload = {
  contactId: string;
  smsOptIn?: false;
  emailOptIn?: false;
  phoneCallOptIn?: false;
  source: string;
  reason: string;
  dryRun: boolean;
};

export type DeliveryContactOptInAttributeValueState = {
  exposed: boolean;
  value: boolean | null;
};

export type DeliveryContactOptInAttributeState = {
  contactId: string | null;
  smsOptIn: DeliveryContactOptInAttributeValueState;
  emailOptIn: DeliveryContactOptInAttributeValueState;
  phoneCallOptIn: DeliveryContactOptInAttributeValueState;
};

export type DeliveryContactOptInAttributesAcumaticaClient = {
  fetchDeliveryContactOptInAttributeStates(
    contactId: string
  ): Promise<DeliveryContactOptInAttributeState[]>;
  putDeliveryContactOptInAttributes(payload: Record<string, unknown>): Promise<{
    status: number;
    body: unknown;
  }>;
};

type EnvSource = Record<string, string | undefined>;

function stringValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function booleanValue(payload: Record<string, unknown>, key: string, fallback: boolean) {
  const value = payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function optionalFalseValue(
  payload: Record<string, unknown>,
  key: DeliveryContactOptInField
): false | undefined {
  if (!(key in payload)) return undefined;
  if (payload[key] !== false) {
    throw new Error(`${key} must be exactly false`);
  }
  return false;
}

function envFlagEnabled(envSource: EnvSource, name: string) {
  return envSource[name]?.trim().toLowerCase() !== "false";
}

function envDryRunEnabled(envSource: EnvSource) {
  return envSource.ACUMATICA_CONTACT_OPT_IN_DRY_RUN?.trim().toLowerCase() === "true";
}

function allowedContactId(envSource: EnvSource) {
  return envSource.ACUMATICA_CONTACT_OPT_IN_ALLOWED_CONTACT_ID?.trim() || null;
}

function cleanErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

export function deliveryContactOptInTargetFields(
  payload: Pick<
    DeliveryContactOptInAttributesPayload,
    "smsOptIn" | "emailOptIn" | "phoneCallOptIn"
  >
): DeliveryContactOptInField[] {
  return (["smsOptIn", "emailOptIn", "phoneCallOptIn"] as const).filter(
    (field) => payload[field] === false
  );
}

export function normalizeDeliveryContactOptInAttributesPayload(
  payload: Record<string, unknown> | undefined
): DeliveryContactOptInAttributesPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload is required");
  }

  const normalized: DeliveryContactOptInAttributesPayload = {
    contactId: stringValue(payload, "contactId"),
    source: stringValue(payload, "source"),
    reason: stringValue(payload, "reason"),
    dryRun: booleanValue(payload, "dryRun", true),
  };

  const smsOptIn = optionalFalseValue(payload, "smsOptIn");
  if (smsOptIn === false) normalized.smsOptIn = false;
  const emailOptIn = optionalFalseValue(payload, "emailOptIn");
  if (emailOptIn === false) normalized.emailOptIn = false;
  const phoneCallOptIn = optionalFalseValue(payload, "phoneCallOptIn");
  if (phoneCallOptIn === false) normalized.phoneCallOptIn = false;

  if (deliveryContactOptInTargetFields(normalized).length === 0) {
    throw new Error("At least one opt-in field must be supplied and must be exactly false");
  }

  return normalized;
}

export function buildDeliveryContactOptInAttributesAcumaticaPayload(
  payload: Pick<DeliveryContactOptInAttributesPayload, "contactId">,
  fields: DeliveryContactOptInField[]
) {
  const contactCustom: Record<string, { type: "CustomBooleanField"; value: false }> = {};

  for (const field of fields) {
    contactCustom[DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_BY_FIELD[field]] = {
      type: "CustomBooleanField",
      value: false,
    };
  }

  return {
    ContactID: { value: payload.contactId },
    custom: {
      Contact: contactCustom,
    },
  };
}

function intendedValues(fields: DeliveryContactOptInField[]) {
  return Object.fromEntries(
    fields.map((field) => [DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_PATH_BY_FIELD[field], false])
  );
}

function currentValues(current: DeliveryContactOptInAttributeState | null) {
  if (!current) return null;
  return {
    [DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_PATH_BY_FIELD.smsOptIn]: current.smsOptIn,
    [DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_PATH_BY_FIELD.emailOptIn]: current.emailOptIn,
    [DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_PATH_BY_FIELD.phoneCallOptIn]: current.phoneCallOptIn,
  };
}

function responseSummary(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return typeof body === "string" ? body.slice(0, 1000) : body;
  }

  const record = body as Record<string, unknown>;
  const contactIdValue = record.ContactID;
  const contactId =
    contactIdValue && typeof contactIdValue === "object" && "value" in contactIdValue
      ? (contactIdValue as { value?: unknown }).value ?? null
      : contactIdValue ?? null;

  const custom = record.custom;
  const contact =
    custom && typeof custom === "object" && "Contact" in custom
      ? (custom as { Contact?: unknown }).Contact
      : null;
  const contactCustom =
    contact && typeof contact === "object" && !Array.isArray(contact)
      ? (contact as Record<string, unknown>)
      : {};

  function customValue(attributeName: string) {
    const raw = contactCustom[attributeName];
    if (raw && typeof raw === "object" && "value" in raw) {
      return (raw as { value?: unknown }).value ?? null;
    }
    return raw ?? null;
  }

  return {
    contactId,
    custom: {
      Contact: {
        AttributeCONTEXT: customValue("AttributeCONTEXT"),
        AttributeCONEMAIL: customValue("AttributeCONEMAIL"),
        AttributeCONPHONE: customValue("AttributeCONPHONE"),
      },
    },
  };
}

function resultBase(params: {
  payload: DeliveryContactOptInAttributesPayload;
  envSource: EnvSource;
  effectiveDryRun: boolean;
  allowedByContactAllowlist: boolean;
  targetFields: DeliveryContactOptInField[];
  writeFields: DeliveryContactOptInField[];
  current?: DeliveryContactOptInAttributeState | null;
}) {
  return {
    dryRun: params.effectiveDryRun,
    liveWriteEnabled: envFlagEnabled(
      params.envSource,
      "ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED"
    ),
    allowedByContactAllowlist: params.allowedByContactAllowlist,
    contactId: params.payload.contactId,
    source: params.payload.source,
    optOutReason: params.payload.reason,
    targetFields: params.targetFields.map(
      (field) => DELIVERY_CONTACT_OPT_IN_ATTRIBUTE_PATH_BY_FIELD[field]
    ),
    currentValues: currentValues(params.current ?? null),
    intendedValues: intendedValues(params.targetFields),
    acumaticaPayload: buildDeliveryContactOptInAttributesAcumaticaPayload(
      params.payload,
      params.writeFields
    ),
  };
}

function allTargetFieldsExposed(
  state: DeliveryContactOptInAttributeState,
  fields: DeliveryContactOptInField[]
) {
  return fields.every((field) => state[field].exposed);
}

function fieldsNeedingWrite(
  state: DeliveryContactOptInAttributeState,
  fields: DeliveryContactOptInField[]
) {
  return fields.filter((field) => state[field].value !== false);
}

function allTargetFieldsFalse(
  state: DeliveryContactOptInAttributeState | null,
  fields: DeliveryContactOptInField[]
) {
  return Boolean(state && fields.every((field) => state[field].value === false));
}

export async function processDeliveryContactOptInAttributesJob(
  payload: Record<string, unknown> | undefined,
  acumaticaClient: DeliveryContactOptInAttributesAcumaticaClient,
  envSource: EnvSource = process.env
) {
  const normalized = normalizeDeliveryContactOptInAttributesPayload(payload);
  const targetFields = deliveryContactOptInTargetFields(normalized);
  const effectiveDryRun = normalized.dryRun || envDryRunEnabled(envSource);
  const allowlist = allowedContactId(envSource);
  const allowedByContactAllowlist = !allowlist || normalized.contactId === allowlist;

  if (effectiveDryRun) {
    return {
      status: "dry_run",
      reason: "dry_run",
      wouldWrite: true,
      stateReadSkipped: true,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields: targetFields,
        current: null,
      }),
    };
  }

  if (!envFlagEnabled(envSource, "ACUMATICA_CONTACT_OPT_IN_WRITE_ENABLED")) {
    return {
      status: "refused",
      reason: "live_write_disabled",
      wouldWrite: false,
      stateReadSkipped: true,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields: targetFields,
        current: null,
      }),
    };
  }

  if (!allowedByContactAllowlist) {
    return {
      status: "refused",
      reason: "contact_not_allowlisted",
      wouldWrite: false,
      stateReadSkipped: true,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields: targetFields,
        current: null,
      }),
    };
  }

  const states = await acumaticaClient.fetchDeliveryContactOptInAttributeStates(
    normalized.contactId
  );

  if (states.length === 0) {
    return {
      status: "failed",
      reason: "contact_not_found",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields: targetFields,
        current: null,
      }),
    };
  }

  if (states.length > 1) {
    return {
      status: "failed",
      reason: "multiple_contacts_found",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields: targetFields,
        current: states[0] ?? null,
      }),
    };
  }

  const current = states[0];
  if (!allTargetFieldsExposed(current, targetFields)) {
    return {
      status: "failed",
      reason: "contact_opt_in_field_not_exposed",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields: targetFields,
        current,
      }),
    };
  }

  const writeFields = fieldsNeedingWrite(current, targetFields);
  if (writeFields.length === 0) {
    return {
      status: "already_false",
      reason: "contact_opt_in_fields_already_false",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields,
        current,
      }),
      verification: {
        before: currentValues(current),
        after: currentValues(current),
      },
    };
  }

  const acumaticaPayload = buildDeliveryContactOptInAttributesAcumaticaPayload(
    normalized,
    writeFields
  );

  try {
    const putResult = await acumaticaClient.putDeliveryContactOptInAttributes(acumaticaPayload);
    const verificationStates = await acumaticaClient.fetchDeliveryContactOptInAttributeStates(
      normalized.contactId
    );
    const after = verificationStates.length === 1 ? verificationStates[0] : null;

    if (!allTargetFieldsFalse(after, targetFields)) {
      return {
        status: "failed",
        reason: "verification_failed",
        wouldWrite: true,
        ...resultBase({
          payload: normalized,
          envSource,
          effectiveDryRun,
          allowedByContactAllowlist,
          targetFields,
          writeFields,
          current,
        }),
        acumaticaResponseSummary: {
          status: putResult.status,
          body: responseSummary(putResult.body),
        },
        verification: {
          before: currentValues(current),
          after: currentValues(after),
        },
      };
    }

    return {
      status: "written",
      reason: "contact_opt_in_fields_written_false",
      wouldWrite: true,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields,
        current,
      }),
      acumaticaResponseSummary: {
        status: putResult.status,
        body: responseSummary(putResult.body),
      },
      verification: {
        before: currentValues(current),
        after: currentValues(after),
      },
    };
  } catch (error) {
    return {
      status: "failed",
      reason: "acumatica_error",
      wouldWrite: true,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByContactAllowlist,
        targetFields,
        writeFields,
        current,
      }),
      errorMessage: cleanErrorMessage(error),
    };
  }
}
