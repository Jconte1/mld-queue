export const DELIVERY_PREPAYMENT_HOLD_REASON = "payment_not_received_by_deadline" as const;

export type DeliveryPrepaymentHoldPayload = {
  orderType: string;
  orderNumber: string;
  reason: typeof DELIVERY_PREPAYMENT_HOLD_REASON;
  dryRun: boolean;
  deliveryDate?: string;
  amountDueAtTrigger?: string | number;
  paymentDeadline?: string;
};

export type DeliveryPrepaymentHoldState = {
  orderType: string | null;
  orderNumber: string | null;
  status: string | null;
  hold: boolean | null;
  holdExposed: boolean;
};

export type DeliveryPrepaymentHoldAcumaticaClient = {
  fetchDeliveryPrepaymentHoldStates(
    orderNumber: string,
    orderType: string
  ): Promise<DeliveryPrepaymentHoldState[]>;
  putDeliveryPrepaymentHold(payload: Record<string, unknown>): Promise<{
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

function optionalAmountValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${key} must be a string or number when provided`);
}

function booleanValue(payload: Record<string, unknown>, key: string, fallback: boolean) {
  const value = payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function normalizeReason(value: string) {
  if (value !== DELIVERY_PREPAYMENT_HOLD_REASON) {
    throw new Error(`reason must be ${DELIVERY_PREPAYMENT_HOLD_REASON}`);
  }
  return value;
}

function envFlagEnabled(envSource: EnvSource, name: string) {
  return envSource[name]?.trim().toLowerCase() === "true";
}

function envDryRunEnabled(envSource: EnvSource) {
  return envSource.ACUMATICA_PREPAYMENT_HOLD_DRY_RUN?.trim().toLowerCase() !== "false";
}

function allowedOrderNumber(envSource: EnvSource) {
  return envSource.ACUMATICA_PREPAYMENT_HOLD_ALLOWED_ORDER_NUMBER?.trim().toUpperCase() || null;
}

function statusContainsHold(status: string | null) {
  return Boolean(status?.toLowerCase().includes("hold"));
}

function isAlreadyOnHold(state: DeliveryPrepaymentHoldState) {
  return state.hold === true && statusContainsHold(state.status);
}

function cleanErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function responseSummary(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return typeof body === "string" ? body.slice(0, 1000) : body;
  }

  const record = body as Record<string, unknown>;
  function field(name: string) {
    const value = record[name];
    if (value && typeof value === "object" && "value" in value) {
      return (value as { value?: unknown }).value ?? null;
    }
    return value ?? null;
  }

  return {
    orderType: field("OrderType"),
    orderNumber: field("OrderNbr"),
    status: field("Status"),
    hold: field("Hold"),
  };
}

export function normalizeDeliveryPrepaymentHoldPayload(
  payload: Record<string, unknown> | undefined
): DeliveryPrepaymentHoldPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload is required");
  }

  return {
    orderType: stringValue(payload, "orderType").toUpperCase(),
    orderNumber: stringValue(payload, "orderNumber").toUpperCase(),
    reason: normalizeReason(stringValue(payload, "reason")),
    dryRun: booleanValue(payload, "dryRun", true),
    deliveryDate: optionalStringValue(payload, "deliveryDate"),
    amountDueAtTrigger: optionalAmountValue(payload, "amountDueAtTrigger"),
    paymentDeadline: optionalStringValue(payload, "paymentDeadline"),
  };
}

export function buildDeliveryPrepaymentHoldAcumaticaPayload(
  payload: Pick<DeliveryPrepaymentHoldPayload, "orderType" | "orderNumber">
) {
  // TODO: Replace existing On Hold write target with configured Prepayment Hold status/action once Acumatica configuration is complete.
  return {
    OrderType: { value: payload.orderType },
    OrderNbr: { value: payload.orderNumber },
    Hold: { value: true },
  };
}

function resultBase(params: {
  payload: DeliveryPrepaymentHoldPayload;
  envSource: EnvSource;
  effectiveDryRun: boolean;
  allowedByOrderAllowlist: boolean;
  current?: DeliveryPrepaymentHoldState | null;
}) {
  return {
    dryRun: params.effectiveDryRun,
    liveWriteEnabled: envFlagEnabled(params.envSource, "ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED"),
    allowedByOrderAllowlist: params.allowedByOrderAllowlist,
    orderType: params.payload.orderType,
    orderNumber: params.payload.orderNumber,
    paymentEnforcementReason: params.payload.reason,
    currentHoldValue: params.current?.hold ?? null,
    currentStatus: params.current?.status ?? null,
    intendedHoldValue: true,
    acumaticaPayload: buildDeliveryPrepaymentHoldAcumaticaPayload(params.payload),
  };
}

export async function processDeliveryPrepaymentHoldJob(
  payload: Record<string, unknown> | undefined,
  acumaticaClient: DeliveryPrepaymentHoldAcumaticaClient,
  envSource: EnvSource = process.env
) {
  const normalized = normalizeDeliveryPrepaymentHoldPayload(payload);
  const effectiveDryRun = normalized.dryRun || envDryRunEnabled(envSource);
  const allowlist = allowedOrderNumber(envSource);
  const allowedByOrderAllowlist = !allowlist || normalized.orderNumber === allowlist;
  const states = await acumaticaClient.fetchDeliveryPrepaymentHoldStates(
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
  if (!current.holdExposed) {
    return {
      status: "failed",
      reason: "hold_field_not_exposed",
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

  if (isAlreadyOnHold(current)) {
    return {
      status: "already_on_hold",
      reason: "already_on_hold",
      wouldWrite: false,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByOrderAllowlist,
        current,
      }),
      verification: {
        holdBefore: current.hold,
        statusBefore: current.status,
        holdAfter: current.hold,
        statusAfter: current.status,
      },
    };
  }

  if (effectiveDryRun) {
    return {
      status: "dry_run",
      reason: "dry_run",
      wouldWrite: true,
      ...resultBase({
        payload: normalized,
        envSource,
        effectiveDryRun,
        allowedByOrderAllowlist,
        current,
      }),
    };
  }

  if (!envFlagEnabled(envSource, "ACUMATICA_PREPAYMENT_HOLD_WRITE_ENABLED")) {
    return {
      status: "refused",
      reason: "live_write_disabled",
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

  if (!allowedByOrderAllowlist) {
    return {
      status: "refused",
      reason: "order_not_allowlisted",
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

  const acumaticaPayload = buildDeliveryPrepaymentHoldAcumaticaPayload(normalized);
  try {
    const putResult = await acumaticaClient.putDeliveryPrepaymentHold(acumaticaPayload);
    const verificationStates = await acumaticaClient.fetchDeliveryPrepaymentHoldStates(
      normalized.orderNumber,
      normalized.orderType
    );
    const after = verificationStates.length === 1 ? verificationStates[0] : null;

    if (!after || !isAlreadyOnHold(after)) {
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
          holdBefore: current.hold,
          statusBefore: current.status,
          holdAfter: after?.hold ?? null,
          statusAfter: after?.status ?? null,
        },
      };
    }

    return {
      status: "succeeded",
      reason: "hold_written",
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
        holdBefore: current.hold,
        statusBefore: current.status,
        holdAfter: after.hold,
        statusAfter: after.status,
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
