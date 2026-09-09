export type DeliveryConfirmationAttributesPayload = {
  orderType: string;
  orderNumber: string;
  confirmedVia: string;
  confirmedWith: string;
  deliveryConfirmationId: string;
  deliveryGroupId: string;
  deliveryDate: string;
  source: string;
  dryRun: boolean;
  note?: string;
};

export type DeliveryConfirmationAttributeRead = {
  exposed: boolean;
  value: string | null;
};

export type DeliveryConfirmationAttributesCurrentValues = {
  orderType: string | null;
  orderNumber: string | null;
  confirmedVia: DeliveryConfirmationAttributeRead;
  confirmedWith: DeliveryConfirmationAttributeRead;
};

export type DeliveryConfirmationAttributesAcumaticaClient = {
  fetchDeliveryConfirmationAttributes(
    orderNumber: string,
    orderType?: string | null
  ): Promise<DeliveryConfirmationAttributesCurrentValues | null>;
  putDeliveryConfirmationAttributes(payload: Record<string, unknown>): Promise<{
    status: number;
    body: unknown;
  }>;
};

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

function isBlank(value: string | null | undefined) {
  return !value || !value.trim();
}

type EnvSource = Record<string, string | undefined>;

export function normalizeDeliveryConfirmationAttributesPayload(
  payload: Record<string, unknown> | undefined
): DeliveryConfirmationAttributesPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload is required");
  }

  return {
    orderType: stringValue(payload, "orderType").toUpperCase(),
    orderNumber: stringValue(payload, "orderNumber").toUpperCase(),
    confirmedVia: stringValue(payload, "confirmedVia"),
    confirmedWith: stringValue(payload, "confirmedWith"),
    deliveryConfirmationId: stringValue(payload, "deliveryConfirmationId"),
    deliveryGroupId: stringValue(payload, "deliveryGroupId"),
    deliveryDate: stringValue(payload, "deliveryDate"),
    source: stringValue(payload, "source"),
    dryRun: booleanValue(payload, "dryRun", false),
    note: typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : undefined,
  };
}

export function buildDeliveryConfirmationAttributeAcumaticaPayload(
  payload: DeliveryConfirmationAttributesPayload,
  fieldsToWrite: { confirmedVia?: boolean; confirmedWith?: boolean } = {
    confirmedVia: true,
    confirmedWith: true,
  }
) {
  const documentAttributes: Record<string, { type: string; value: string }> = {};

  if (fieldsToWrite.confirmedVia) {
    documentAttributes.AttributeCONFIRMVIA = {
      type: "CustomStringField",
      value: payload.confirmedVia,
    };
  }

  if (fieldsToWrite.confirmedWith) {
    documentAttributes.AttributeCONFIRMWTH = {
      type: "CustomStringField",
      value: payload.confirmedWith,
    };
  }

  return {
    OrderType: { value: payload.orderType },
    OrderNbr: { value: payload.orderNumber },
    custom: {
      Document: documentAttributes,
    },
  };
}

function resultBase(
  normalized: DeliveryConfirmationAttributesPayload
) {
  return {
    orderType: normalized.orderType,
    orderNumber: normalized.orderNumber,
    fields: {
      "Document.AttributeCONFIRMVIA": normalized.confirmedVia,
      "Document.AttributeCONFIRMWTH": normalized.confirmedWith,
    },
    trace: {
      deliveryConfirmationId: normalized.deliveryConfirmationId,
      deliveryGroupId: normalized.deliveryGroupId,
      deliveryDate: normalized.deliveryDate,
      source: normalized.source,
      note: normalized.note ?? null,
    },
    liveWriteConfig: {
      enabled: true,
      mode: "production_default",
    },
  };
}

export function buildDeliveryConfirmationAttributesDryRunResult(
  payload: Record<string, unknown> | undefined
) {
  const normalized = normalizeDeliveryConfirmationAttributesPayload(payload);
  const forcedDryRun = { ...normalized, dryRun: true };
  const acumaticaPayload = buildDeliveryConfirmationAttributeAcumaticaPayload(forcedDryRun);

  return {
    status: "dry_run",
    wouldWrite: true,
    dryRun: true,
    skippedLiveWrite: true,
    liveWriteEnabled: false,
    futureLiveWriteRequires: "dryRun=false",
    ...resultBase(forcedDryRun),
    acumaticaPayload,
  };
}

export async function processDeliveryConfirmationAttributesJob(
  payload: Record<string, unknown> | undefined,
  acumaticaClient: DeliveryConfirmationAttributesAcumaticaClient,
  envSource: EnvSource = process.env
) {
  const normalized = normalizeDeliveryConfirmationAttributesPayload(payload);
  const acumaticaPayload = buildDeliveryConfirmationAttributeAcumaticaPayload(normalized);
  void envSource;

  if (normalized.dryRun) {
    return {
      status: "dry_run",
      wouldWrite: true,
      dryRun: true,
      skippedLiveWrite: true,
      liveWriteEnabled: true,
      futureLiveWriteRequires: "dryRun=false",
      ...resultBase(normalized),
      acumaticaPayload,
    };
  }

  const current = await acumaticaClient.fetchDeliveryConfirmationAttributes(
    normalized.orderNumber,
    normalized.orderType
  );

  if (!current) {
    return {
      status: "blocked_sales_order_not_found",
      reason: "sales_order_not_found",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled: true,
      ...resultBase(normalized),
      currentValues: null,
      acumaticaPayload,
    };
  }

  const fieldsReadable = current.confirmedVia.exposed && current.confirmedWith.exposed;
  if (!fieldsReadable) {
    return {
      status: "blocked_fields_not_exposed",
      reason: "confirmation_attributes_not_readable",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled: true,
      ...resultBase(normalized),
      currentValues: current,
      acumaticaPayload,
    };
  }

  const fieldsToWrite = {
    confirmedVia: isBlank(current.confirmedVia.value),
    confirmedWith: isBlank(current.confirmedWith.value),
  };

  if (!fieldsToWrite.confirmedVia && !fieldsToWrite.confirmedWith) {
    return {
      status: "skipped_existing_value",
      reason: "confirmation_attributes_already_populated",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled: true,
      ...resultBase(normalized),
      currentValues: current,
      acumaticaPayload,
    };
  }

  const partialPayload = buildDeliveryConfirmationAttributeAcumaticaPayload(normalized, fieldsToWrite);
  const putResult = await acumaticaClient.putDeliveryConfirmationAttributes(partialPayload);

  return {
    status: "written",
    wouldWrite: true,
    dryRun: false,
    skippedLiveWrite: false,
    liveWriteEnabled: true,
    ...resultBase(normalized),
    currentValues: current,
    fieldsWritten: {
      "Document.AttributeCONFIRMVIA": fieldsToWrite.confirmedVia,
      "Document.AttributeCONFIRMWTH": fieldsToWrite.confirmedWith,
    },
    acumaticaPayload: partialPayload,
    acumaticaResponse: {
      status: putResult.status,
      body: putResult.body,
    },
  };
}
