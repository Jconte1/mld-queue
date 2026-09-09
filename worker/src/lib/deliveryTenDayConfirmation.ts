export const DELIVERY_TEN_DAY_CONFIRMATION_REASON = "delivery_group_cleared" as const;

export type DeliveryTenDayConfirmationPayload = {
  orderType: string;
  orderNumber: string;
  dryRun: boolean;
  reason: typeof DELIVERY_TEN_DAY_CONFIRMATION_REASON;
  deliveryDate?: string;
  sourceInterval?: string;
};

export type DeliveryTenDayConfirmationState = {
  orderType: string | null;
  orderNumber: string | null;
  oneWeekConfirmed: boolean | null;
  oneWeekConfirmedExposed: boolean;
};

export type DeliveryTenDayConfirmationAcumaticaClient = {
  fetchDeliveryTenDayConfirmationStates(
    orderNumber: string,
    orderType: string
  ): Promise<DeliveryTenDayConfirmationState[]>;
  putDeliveryTenDayConfirmation(payload: Record<string, unknown>): Promise<{
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

function optionalStringValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-blank string when provided`);
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

function normalizeReason(value: string | undefined) {
  if (!value) return DELIVERY_TEN_DAY_CONFIRMATION_REASON;
  if (value !== DELIVERY_TEN_DAY_CONFIRMATION_REASON) {
    throw new Error(`reason must be ${DELIVERY_TEN_DAY_CONFIRMATION_REASON}`);
  }
  return value;
}

function envDryRunEnabled(envSource: EnvSource) {
  return envSource.ACUMATICA_TEN_DAY_CONFIRMATION_DRY_RUN?.trim().toLowerCase() === "true";
}

function cleanErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function fieldValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value && typeof value === "object" && "value" in value) {
    return (value as { value?: unknown }).value ?? null;
  }
  return value ?? null;
}

function customDocumentValue(record: Record<string, unknown>, key: string) {
  const custom = record.custom;
  if (!custom || typeof custom !== "object" || !("Document" in custom)) return null;
  const document = (custom as { Document?: unknown }).Document;
  if (!document || typeof document !== "object" || !(key in document)) return null;
  const value = (document as Record<string, unknown>)[key];
  if (value && typeof value === "object" && "value" in value) {
    return (value as { value?: unknown }).value ?? null;
  }
  return value ?? null;
}

function responseSummary(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return typeof body === "string" ? body.slice(0, 1000) : body;
  }

  const record = body as Record<string, unknown>;
  return {
    orderType: fieldValue(record, "OrderType"),
    orderNumber: fieldValue(record, "OrderNbr"),
    oneWeekConfirmed: customDocumentValue(record, "AttributeONEWEEKCON"),
  };
}

export function normalizeDeliveryTenDayConfirmationPayload(
  payload: Record<string, unknown> | undefined
): DeliveryTenDayConfirmationPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload is required");
  }

  return {
    orderType: stringValue(payload, "orderType").toUpperCase(),
    orderNumber: stringValue(payload, "orderNumber").toUpperCase(),
    dryRun: booleanValue(payload, "dryRun", true),
    reason: normalizeReason(optionalStringValue(payload, "reason")),
    deliveryDate: optionalStringValue(payload, "deliveryDate"),
    sourceInterval: optionalStringValue(payload, "sourceInterval"),
  };
}

export function buildDeliveryTenDayConfirmationAcumaticaPayload(
  payload: Pick<DeliveryTenDayConfirmationPayload, "orderType" | "orderNumber">
) {
  return {
    OrderType: { value: payload.orderType },
    OrderNbr: { value: payload.orderNumber },
    custom: {
      Document: {
        AttributeONEWEEKCON: {
          type: "CustomBooleanField",
          value: true,
        },
      },
    },
  };
}

function resultBase(params: {
  payload: DeliveryTenDayConfirmationPayload;
  envSource: EnvSource;
  effectiveDryRun: boolean;
  allowedByOrderAllowlist: boolean;
  current?: DeliveryTenDayConfirmationState | null;
}) {
  return {
    dryRun: params.effectiveDryRun,
    liveWriteEnabled: true,
    allowedByOrderAllowlist: true,
    liveWriteConfig: {
      mode: "production_default",
    },
    orderType: params.payload.orderType,
    orderNumber: params.payload.orderNumber,
    confirmationReason: params.payload.reason,
    trace: {
      deliveryDate: params.payload.deliveryDate ?? null,
      sourceInterval: params.payload.sourceInterval ?? null,
    },
    currentOneWeekConfirmed: params.current?.oneWeekConfirmed ?? null,
    intendedOneWeekConfirmed: true,
    acumaticaPayload: buildDeliveryTenDayConfirmationAcumaticaPayload(params.payload),
  };
}

export async function processDeliveryTenDayConfirmationJob(
  payload: Record<string, unknown> | undefined,
  acumaticaClient: DeliveryTenDayConfirmationAcumaticaClient,
  envSource: EnvSource = process.env
) {
  const normalized = normalizeDeliveryTenDayConfirmationPayload(payload);
  const effectiveDryRun = normalized.dryRun || envDryRunEnabled(envSource);
  const allowedByOrderAllowlist = true;

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
        allowedByOrderAllowlist,
        current: null,
      }),
    };
  }

  const states = await acumaticaClient.fetchDeliveryTenDayConfirmationStates(
    normalized.orderNumber,
    normalized.orderType
  );

  if (states.length === 0) {
    return {
      status: "failed",
      reason: "sales_order_not_found",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByOrderAllowlist,
        current: null,
      }),
    };
  }

  if (states.length > 1) {
    return {
      status: "failed",
      reason: "multiple_sales_orders_found",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByOrderAllowlist,
        current: states[0] ?? null,
      }),
    };
  }

  const current = states[0];
  if (!current.oneWeekConfirmedExposed) {
    return {
      status: "failed",
      reason: "one_week_confirmation_field_not_exposed",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByOrderAllowlist,
        current,
      }),
    };
  }

  if (current.oneWeekConfirmed === true) {
    return {
      status: "already_true",
      reason: "one_week_confirmation_already_true",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByOrderAllowlist,
        current,
      }),
      verification: {
        oneWeekConfirmedBefore: current.oneWeekConfirmed,
        oneWeekConfirmedAfter: current.oneWeekConfirmed,
      },
    };
  }

  const acumaticaPayload = buildDeliveryTenDayConfirmationAcumaticaPayload(normalized);
  try {
    const putResult = await acumaticaClient.putDeliveryTenDayConfirmation(acumaticaPayload);
    const verificationStates = await acumaticaClient.fetchDeliveryTenDayConfirmationStates(
      normalized.orderNumber,
      normalized.orderType
    );
    const after = verificationStates.length === 1 ? verificationStates[0] : null;

    if (!after || after.oneWeekConfirmed !== true) {
      return {
        status: "failed",
        reason: "verification_failed",
        wouldWrite: true,
        ...resultBase({
          payload: normalized,
          envSource,
          effectiveDryRun,
          allowedByOrderAllowlist,
          current,
        }),
        acumaticaResponseSummary: {
          status: putResult.status,
          body: responseSummary(putResult.body),
        },
        verification: {
          oneWeekConfirmedBefore: current.oneWeekConfirmed,
          oneWeekConfirmedAfter: after?.oneWeekConfirmed ?? null,
        },
      };
    }

    return {
      status: "written",
      reason: "one_week_confirmation_written",
      wouldWrite: true,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByOrderAllowlist,
        current,
      }),
      acumaticaResponseSummary: {
        status: putResult.status,
        body: responseSummary(putResult.body),
      },
      verification: {
        oneWeekConfirmedBefore: current.oneWeekConfirmed,
        oneWeekConfirmedAfter: after.oneWeekConfirmed,
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
        allowedByOrderAllowlist,
        current,
      }),
      errorMessage: cleanErrorMessage(error),
    };
  }
}
