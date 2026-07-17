export type DeliveryConfirmationAttributesPayload = {
  orderType: string;
  orderNumber: string;
  confirmedVia: string;
  confirmedWith: string;
  deliveryConfirmationId: string;
  deliveryGroupId: string;
  deliveryDate: string;
  source: string;
  dryRun: true;
  note?: string;
};

function stringValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

export function normalizeDeliveryConfirmationAttributesPayload(
  payload: Record<string, unknown> | undefined
): DeliveryConfirmationAttributesPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload is required");
  }

  if (payload.dryRun !== true) {
    throw new Error(
      "dryRun=true is required for ERP_UPDATE_DELIVERY_CONFIRMATION_ATTRIBUTES; live Acumatica writeback is disabled"
    );
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
    dryRun: true,
    note: typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : undefined,
  };
}

export function buildDeliveryConfirmationAttributeAcumaticaPayload(
  payload: DeliveryConfirmationAttributesPayload
) {
  return {
    OrderType: { value: payload.orderType },
    OrderNbr: { value: payload.orderNumber },
    custom: {
      Document: {
        AttributeCONFIRMVIA: {
          type: "CustomStringField",
          value: payload.confirmedVia,
        },
        AttributeCONFIRMWTH: {
          type: "CustomStringField",
          value: payload.confirmedWith,
        },
      },
    },
  };
}

export function buildDeliveryConfirmationAttributesDryRunResult(
  payload: Record<string, unknown> | undefined
) {
  const normalized = normalizeDeliveryConfirmationAttributesPayload(payload);
  const acumaticaPayload = buildDeliveryConfirmationAttributeAcumaticaPayload(normalized);

  return {
    wouldWrite: true,
    dryRun: true,
    skippedLiveWrite: true,
    liveWriteEnabled: false,
    futureLiveWriteRequires:
      "ACUMATICA_CONFIRMATION_WRITEBACK_ENABLED=true and a separate live-write implementation",
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
    acumaticaPayload,
  };
}
