export type DeliveryRequestedDatePayload = {
  orderType: string;
  orderNumber: string;
  deliveryConfirmationId: string;
  deliveryGroupId: string;
  originalDeliveryDate: string;
  requestedDeliveryDate: string;
  lineNumbers: number[];
  source: "WEBPAGE" | "SMS";
  dryRun: boolean;
  requestedAt?: string;
  requestedBy?: Record<string, unknown>;
  note?: string;
};

export type DeliveryRequestedDateLineState = {
  lineNbr: number | null;
  id: string | null;
  requestedOnExposed: boolean;
  requestedOnRaw: string | null;
  requestedOnDateKey: string | null;
  inventoryId: string | null;
};

export type DeliveryRequestedDateAcumaticaClient = {
  fetchDeliverySalesOrderFull(
    orderNumber: string,
    orderType?: string | null
  ): Promise<Record<string, unknown>[]>;
  putDeliveryRequestedDateLines(payload: Record<string, unknown>): Promise<{
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
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(payload: Record<string, unknown>, key: string, fallback: boolean) {
  const value = payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function normalizeSource(value: string): "WEBPAGE" | "SMS" {
  const normalized = value.trim().toUpperCase();
  if (normalized !== "WEBPAGE" && normalized !== "SMS") {
    throw new Error("source must be WEBPAGE or SMS");
  }
  return normalized;
}

function normalizeDateKey(value: string, fieldName: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName} is required`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T00:00:00.000Z`)
    : new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date.toISOString().slice(0, 10);
}

function requestedOnDateTime(dateKey: string) {
  return `${dateKey}T00:00:00.000Z`;
}

function normalizeLineNumbers(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("lineNumbers must be an array");
  }

  const normalized = Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((lineNumber) => Number.isInteger(lineNumber) && lineNumber > 0)
    )
  ).sort((left, right) => left - right);

  if (normalized.length === 0) {
    throw new Error("lineNumbers must contain at least one positive integer");
  }

  return normalized;
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

function isLiveWritebackEnabled(envSource: EnvSource) {
  return envSource.ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED?.trim().toLowerCase() !== "false";
}

export function evaluateDeliveryRequestedDateWritebackLiveGate(
  normalized: Pick<DeliveryRequestedDatePayload, "orderType" | "orderNumber">,
  envSource: EnvSource = process.env
) {
  const allowedOrderNumbers = listValues(
    envSource.ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_NBRS
  );
  const allowedOrderTypes = listValues(
    envSource.ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_TYPES
  );
  const orderNumbersConfigured = allowedOrderNumbers.size > 0;
  const orderTypesConfigured = allowedOrderTypes.size > 0;
  const allowlistConfigured = orderNumbersConfigured || orderTypesConfigured;
  const allowAll =
    flagIsTrue(envSource, "ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL") ||
    (!allowlistConfigured &&
      envSource.ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL?.trim().toLowerCase() !== "false");
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

export function normalizeDeliveryRequestedDatePayload(
  payload: Record<string, unknown> | undefined
): DeliveryRequestedDatePayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload is required");
  }

  return {
    orderType: stringValue(payload, "orderType").toUpperCase(),
    orderNumber: stringValue(payload, "orderNumber").toUpperCase(),
    deliveryConfirmationId: stringValue(payload, "deliveryConfirmationId"),
    deliveryGroupId: stringValue(payload, "deliveryGroupId"),
    originalDeliveryDate: normalizeDateKey(stringValue(payload, "originalDeliveryDate"), "originalDeliveryDate"),
    requestedDeliveryDate: normalizeDateKey(
      stringValue(payload, "requestedDeliveryDate"),
      "requestedDeliveryDate"
    ),
    lineNumbers: normalizeLineNumbers(payload.lineNumbers),
    source: normalizeSource(stringValue(payload, "source")),
    dryRun: booleanValue(payload, "dryRun", false),
    requestedAt: optionalStringValue(payload, "requestedAt"),
    requestedBy:
      payload.requestedBy && typeof payload.requestedBy === "object" && !Array.isArray(payload.requestedBy)
        ? (payload.requestedBy as Record<string, unknown>)
        : undefined,
    note: optionalStringValue(payload, "note"),
  };
}

export function buildDeliveryRequestedDateAcumaticaPayload(
  payload: DeliveryRequestedDatePayload,
  lineStates: DeliveryRequestedDateLineState[] = []
) {
  const requestedDateTime = requestedOnDateTime(payload.requestedDeliveryDate);
  const lineIdsByNumber = new Map(
    lineStates
      .filter((line): line is DeliveryRequestedDateLineState & { lineNbr: number; id: string } => {
        return line.lineNbr !== null && typeof line.id === "string" && line.id.trim().length > 0;
      })
      .map((line) => [line.lineNbr, line.id.trim()])
  );

  return {
    OrderType: { value: payload.orderType },
    OrderNbr: { value: payload.orderNumber },
    Details: payload.lineNumbers.map((lineNbr) => {
      const detail: Record<string, unknown> = {
        LineNbr: { value: lineNbr },
        RequestedOn: { value: requestedDateTime },
      };
      const id = lineIdsByNumber.get(lineNbr);
      if (id) detail.id = id;
      return detail;
    }),
  };
}

function unwrapAcumaticaValue(value: unknown) {
  if (value && typeof value === "object" && "value" in value) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

function acumaticaString(row: Record<string, unknown> | null, key: string) {
  if (!row) return null;
  const raw = unwrapAcumaticaValue(row[key]);
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed || null;
}

function acumaticaInteger(row: Record<string, unknown> | null, key: string) {
  const value = acumaticaString(row, key);
  if (!value) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function acumaticaDateKey(row: Record<string, unknown> | null, key: string) {
  const value = acumaticaString(row, key);
  if (!value) return null;
  try {
    return normalizeDateKey(value, key);
  } catch {
    return null;
  }
}

function acumaticaRows(value: unknown): Record<string, unknown>[] {
  const raw = unwrapAcumaticaValue(value);
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is Record<string, unknown> => {
    return Boolean(row && typeof row === "object" && !Array.isArray(row));
  });
}

export function readDeliveryRequestedDateLineStates(
  order: Record<string, unknown>
): DeliveryRequestedDateLineState[] {
  return acumaticaRows(order.Details).map((line) => ({
    lineNbr: acumaticaInteger(line, "LineNbr"),
    id: acumaticaString(line, "id"),
    requestedOnExposed: Object.prototype.hasOwnProperty.call(line, "RequestedOn"),
    requestedOnRaw: acumaticaString(line, "RequestedOn"),
    requestedOnDateKey: acumaticaDateKey(line, "RequestedOn"),
    inventoryId: acumaticaString(line, "InventoryID"),
  }));
}

function resultBase(
  normalized: DeliveryRequestedDatePayload,
  envSource: EnvSource = process.env
) {
  const liveWriteEnabled = isLiveWritebackEnabled(envSource);
  const liveWriteGate = evaluateDeliveryRequestedDateWritebackLiveGate(normalized, envSource);
  return {
    orderType: normalized.orderType,
    orderNumber: normalized.orderNumber,
    fields: {
      "Details[].LineNbr": normalized.lineNumbers,
      "Details[].RequestedOn": requestedOnDateTime(normalized.requestedDeliveryDate),
    },
    trace: {
      deliveryConfirmationId: normalized.deliveryConfirmationId,
      deliveryGroupId: normalized.deliveryGroupId,
      originalDeliveryDate: normalized.originalDeliveryDate,
      requestedDeliveryDate: normalized.requestedDeliveryDate,
      requestedAt: normalized.requestedAt ?? null,
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

function currentOrderIdentity(order: Record<string, unknown>) {
  return {
    orderType: acumaticaString(order, "OrderType")?.toUpperCase() ?? null,
    orderNumber: acumaticaString(order, "OrderNbr")?.toUpperCase() ?? null,
  };
}

function targetLineSummary(lines: DeliveryRequestedDateLineState[]) {
  return lines.map((line) => ({
    lineNbr: line.lineNbr,
    hasId: Boolean(line.id),
    requestedOnExposed: line.requestedOnExposed,
    requestedOnRaw: line.requestedOnRaw,
    requestedOnDateKey: line.requestedOnDateKey,
    inventoryId: line.inventoryId,
  }));
}

function targetLinesByNumber(lines: DeliveryRequestedDateLineState[]) {
  return new Map(
    lines
      .filter((line): line is DeliveryRequestedDateLineState & { lineNbr: number } => line.lineNbr !== null)
      .map((line) => [line.lineNbr, line])
  );
}

function verifiedRequestedDateLineState(params: {
  lines: DeliveryRequestedDateLineState[];
  targetLineNumbers: number[];
  requestedDeliveryDate: string;
}) {
  const linesByNumber = targetLinesByNumber(params.lines);
  const targetLines: DeliveryRequestedDateLineState[] = [];
  const missingLineNumbers: number[] = [];
  for (const lineNbr of params.targetLineNumbers) {
    const line = linesByNumber.get(lineNbr);
    if (line) {
      targetLines.push(line);
    } else {
      missingLineNumbers.push(lineNbr);
    }
  }
  const mismatchedLines = targetLines.filter(
    (line) => line.requestedOnDateKey !== params.requestedDeliveryDate
  );

  return {
    verified: missingLineNumbers.length === 0 && mismatchedLines.length === 0,
    missingLineNumbers,
    targetLines,
    mismatchedLines,
  };
}

export function buildDeliveryRequestedDateDryRunResult(
  payload: Record<string, unknown> | undefined
) {
  const normalized = normalizeDeliveryRequestedDatePayload(payload);
  const forcedDryRun = { ...normalized, dryRun: true };
  const acumaticaPayload = buildDeliveryRequestedDateAcumaticaPayload(forcedDryRun);

  return {
    status: "dry_run",
    wouldWrite: true,
    dryRun: true,
    skippedLiveWrite: true,
    liveWriteEnabled: false,
    futureLiveWriteRequires:
      "dryRun=false, ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED=true, and ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL=true or a matching ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_NBRS/ALLOWED_ORDER_TYPES allowlist",
    ...resultBase(forcedDryRun),
    acumaticaPayload,
  };
}

export async function processDeliveryRequestedDateJob(
  payload: Record<string, unknown> | undefined,
  acumaticaClient: DeliveryRequestedDateAcumaticaClient,
  envSource: EnvSource = process.env
) {
  const normalized = normalizeDeliveryRequestedDatePayload(payload);
  const acumaticaPayload = buildDeliveryRequestedDateAcumaticaPayload(normalized);
  const liveWriteEnabled = isLiveWritebackEnabled(envSource);

  if (normalized.dryRun) {
    return {
      status: "dry_run",
      wouldWrite: true,
      dryRun: true,
      skippedLiveWrite: true,
      liveWriteEnabled,
      futureLiveWriteRequires:
        "dryRun=false, ACUMATICA_REQUESTED_DATE_WRITEBACK_ENABLED=true, and ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOW_ALL=true or a matching ACUMATICA_REQUESTED_DATE_WRITEBACK_ALLOWED_ORDER_NBRS/ALLOWED_ORDER_TYPES allowlist",
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

  const liveWriteGate = evaluateDeliveryRequestedDateWritebackLiveGate(normalized, envSource);
  if (!liveWriteGate.allowedByLiveWriteGate) {
    return {
      status: "live_write_refused",
      reason: "requested_date_writeback_not_allowlisted",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      acumaticaPayload,
    };
  }

  const rows = await acumaticaClient.fetchDeliverySalesOrderFull(
    normalized.orderNumber,
    normalized.orderType
  );
  const current = rows[0] || null;
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

  const currentIdentity = currentOrderIdentity(current);
  if (
    currentIdentity.orderType !== normalized.orderType ||
    currentIdentity.orderNumber !== normalized.orderNumber
  ) {
    return {
      status: "blocked_order_mismatch",
      reason: "sales_order_identity_mismatch",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      currentValues: currentIdentity,
      acumaticaPayload,
    };
  }

  const currentLines = readDeliveryRequestedDateLineStates(current);
  const linesByNumber = targetLinesByNumber(currentLines);
  const missingLineNumbers = normalized.lineNumbers.filter((lineNbr) => !linesByNumber.has(lineNbr));
  if (missingLineNumbers.length > 0) {
    return {
      status: "blocked_line_not_found",
      reason: "requested_date_target_line_not_found",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      currentValues: {
        ...currentIdentity,
        missingLineNumbers,
      },
      acumaticaPayload,
    };
  }

  const targetLines = normalized.lineNumbers.map((lineNbr) => linesByNumber.get(lineNbr)!);
  const missingIds = targetLines.filter((line) => !line.id);
  if (missingIds.length > 0) {
    return {
      status: "blocked_line_identity_not_exposed",
      reason: "requested_date_target_line_id_not_readable",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      currentValues: {
        ...currentIdentity,
        targetLines: targetLineSummary(targetLines),
      },
      acumaticaPayload,
    };
  }

  const notExposed = targetLines.filter((line) => !line.requestedOnExposed);
  if (notExposed.length > 0) {
    return {
      status: "blocked_requested_on_not_exposed",
      reason: "requested_on_not_readable",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      currentValues: {
        ...currentIdentity,
        targetLines: targetLineSummary(targetLines),
      },
      acumaticaPayload,
    };
  }

  const staleLines = targetLines.filter(
    (line) => line.requestedOnDateKey !== normalized.originalDeliveryDate
  );
  if (staleLines.length > 0) {
    const alreadyApplied = staleLines.every(
      (line) => line.requestedOnDateKey === normalized.requestedDeliveryDate
    );
    return {
      status: alreadyApplied ? "skipped_existing_value" : "blocked_stale_line_requested_on",
      reason: alreadyApplied ? "requested_date_already_applied" : "requested_on_no_longer_matches_original",
      wouldWrite: false,
      dryRun: false,
      skippedLiveWrite: true,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      currentValues: {
        ...currentIdentity,
        targetLines: targetLineSummary(targetLines),
      },
      acumaticaPayload,
    };
  }

  const writePayload = buildDeliveryRequestedDateAcumaticaPayload(normalized, targetLines);
  const putResult = await acumaticaClient.putDeliveryRequestedDateLines(writePayload);
  const verificationRows = await acumaticaClient.fetchDeliverySalesOrderFull(
    normalized.orderNumber,
    normalized.orderType
  );
  const verificationCurrent = verificationRows[0] || null;
  const verificationIdentity = verificationCurrent ? currentOrderIdentity(verificationCurrent) : null;

  if (
    !verificationCurrent ||
    verificationIdentity?.orderType !== normalized.orderType ||
    verificationIdentity.orderNumber !== normalized.orderNumber
  ) {
    return {
      status: "failed",
      reason: "requested_date_verification_order_not_found",
      wouldWrite: true,
      dryRun: false,
      skippedLiveWrite: false,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      currentValues: {
        ...currentIdentity,
        targetLines: targetLineSummary(targetLines),
      },
      verification: {
        orderFound: Boolean(verificationCurrent),
        orderIdentity: verificationIdentity,
        verified: false,
      },
      acumaticaPayload: writePayload,
      acumaticaResponse: {
        status: putResult.status,
        body: putResult.body,
      },
    };
  }

  const verification = verifiedRequestedDateLineState({
    lines: readDeliveryRequestedDateLineStates(verificationCurrent),
    targetLineNumbers: normalized.lineNumbers,
    requestedDeliveryDate: normalized.requestedDeliveryDate,
  });

  if (!verification.verified) {
    return {
      status: "failed",
      reason: "requested_date_verification_failed",
      wouldWrite: true,
      dryRun: false,
      skippedLiveWrite: false,
      liveWriteEnabled,
      ...resultBase(normalized, envSource),
      currentValues: {
        ...currentIdentity,
        targetLines: targetLineSummary(targetLines),
      },
      verification: {
        verified: false,
        expectedRequestedOn: normalized.requestedDeliveryDate,
        missingLineNumbers: verification.missingLineNumbers,
        mismatchedLines: targetLineSummary(verification.mismatchedLines),
        targetLinesAfterWrite: targetLineSummary(verification.targetLines),
      },
      acumaticaPayload: writePayload,
      acumaticaResponse: {
        status: putResult.status,
        body: putResult.body,
      },
    };
  }

  return {
    status: "written",
    wouldWrite: true,
    dryRun: false,
    skippedLiveWrite: false,
    liveWriteEnabled,
    ...resultBase(normalized, envSource),
    currentValues: {
      ...currentIdentity,
      targetLines: targetLineSummary(targetLines),
    },
    acumaticaPayload: writePayload,
    acumaticaResponse: {
      status: putResult.status,
      body: putResult.body,
    },
    verification: {
      verified: true,
      expectedRequestedOn: normalized.requestedDeliveryDate,
      targetLinesAfterWrite: targetLineSummary(verification.targetLines),
    },
  };
}
