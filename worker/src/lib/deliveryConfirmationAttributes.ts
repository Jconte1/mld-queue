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

function isLiveWritebackEnabled(envSource: EnvSource) {
  return envSource.ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED?.trim().toLowerCase() !== "false";
}

function flagIsTrue(envSource: EnvSource, name: string) {
  return envSource[name]?.trim().toLowerCase() === "true";
}

function listValues(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(/[,\s;]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
  );
}

export function evaluateDeliveryConfirmationWritebackLiveGate(
  normalized: Pick<DeliveryConfirmationAttributesPayload, "orderType" | "orderNumber">,
  envSource: EnvSource = process.env
) {
  const allowedOrderNumbers = listValues(
    envSource.ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS
  );
  const allowedOrderTypes = listValues(
    envSource.ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_TYPES
  );
  const orderNumbersConfigured = allowedOrderNumbers.size > 0;
  const orderTypesConfigured = allowedOrderTypes.size > 0;
  const allowlistConfigured = orderNumbersConfigured || orderTypesConfigured;
  const allowAll =
    flagIsTrue(envSource, "ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL") ||
    (!allowlistConfigured &&
      envSource.ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL?.trim().toLowerCase() !== "false");
  const allowedByOrderNumber =
    orderNumbersConfigured && allowedOrderNumbers.has(normalized.orderNumber.toUpperCase());
  const allowedByOrderType =
    orderTypesConfigured && allowedOrderTypes.has(normalized.orderType.toUpperCase());
  const allowedByAllowlist =
    allowlistConfigured &&
    (orderNumbersConfigured ? allowedByOrderNumber : true) &&
    (orderTypesConfigured ? allowedByOrderType : true);
  const allowedByLiveWriteGate = allowAll || allowedByAllowlist;

  return {
    allowAll,
    orderNumbersConfigured,
    orderTypesConfigured,
    allowedByOrderNumber,
    allowedByOrderType,
    allowedByAllowlist,
    allowedByLiveWriteGate,
  };
}

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
  normalized: DeliveryConfirmationAttributesPayload,
  envSource: EnvSource = process.env
) {
  const liveWriteEnabled = isLiveWritebackEnabled(envSource);
  const liveWriteGate = evaluateDeliveryConfirmationWritebackLiveGate(normalized, envSource);
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
      enabled: liveWriteEnabled,
      allowAll: liveWriteGate.allowAll,
      orderNumbersConfigured: liveWriteGate.orderNumbersConfigured,
      orderTypesConfigured: liveWriteGate.orderTypesConfigured,
      allowedByOrderNumber: liveWriteGate.allowedByOrderNumber,
      allowedByOrderType: liveWriteGate.allowedByOrderType,
      allowedByAllowlist: liveWriteGate.allowedByAllowlist,
      allowedByLiveWriteGate: liveWriteGate.allowedByLiveWriteGate,
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
    futureLiveWriteRequires:
      "dryRun=false, ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED=true, and ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL=true or a matching ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS/ALLOWED_ORDER_TYPES allowlist",
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
  const liveWriteEnabled = isLiveWritebackEnabled(envSource);

  if (normalized.dryRun) {
    return {
      status: "dry_run",
      wouldWrite: true,
      dryRun: true,
      skippedLiveWrite: true,
      liveWriteEnabled,
      futureLiveWriteRequires:
        "dryRun=false, ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED=true, and ACUMATICA_CONFIRMATION_WRITEBACK_ALLOW_ALL=true or a matching ACUMATICA_CONFIRMATION_WRITEBACK_ALLOWED_ORDER_NBRS/ALLOWED_ORDER_TYPES allowlist",
      ...resultBase(normalized, envSource),
      acumaticaPayload,
    };
  }

  if (!liveWriteEnabled) {
    return {
      status: "live_write_refused",
      reason: "live_writeback_disabled",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      acumaticaPayload,
    };
  }

  const liveWriteGate = evaluateDeliveryConfirmationWritebackLiveGate(normalized, envSource);
  if (!liveWriteGate.allowedByLiveWriteGate) {
    return {
      status: "live_write_refused",
      reason: "confirmation_writeback_not_allowlisted",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
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
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
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
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
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
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
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
    liveWriteEnabled,
    ...resultBase(normalized, envSource),
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
