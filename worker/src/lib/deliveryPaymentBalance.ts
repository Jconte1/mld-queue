export type DeliveryPaymentBalanceClient = {
  fetchDeliverySalesOrderFull(orderNumber: string, orderType: string): Promise<Record<string, unknown>[]>;
};

function value(record: Record<string, unknown>, name: string): unknown {
  const raw = record[name];
  return raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
}

export async function readFreshDeliveryPaymentBalance(
  client: DeliveryPaymentBalanceClient, orderType: string, orderNumber: string, deliveryDate?: string
) {
  const rows = await client.fetchDeliverySalesOrderFull(orderNumber, orderType);
  if (rows.length !== 1 || value(rows[0], "OrderType") !== orderType || value(rows[0], "OrderNbr") !== orderNumber) {
    throw new Error("fresh_payment_order_not_unique");
  }
  const order = rows[0];
  const totalsValue = value(order, "Totals");
  const totals = Array.isArray(totalsValue) ? totalsValue[0] : totalsValue;
  const raw = totals && typeof totals === "object" ? value(totals, "UnpaidBalance") : undefined;
  const text = String(raw ?? "").trim();
  const terms = String(value(order, "Terms") ?? "").trim().toUpperCase();
  if (!terms || !/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
    throw new Error("fresh_payment_balance_or_terms_missing");
  }
  const status = String(value(order, "Status") ?? "").trim().toLowerCase();
  if (!status || /^(completed?|closed|cancelled|canceled|voided)$/.test(status)) {
    throw new Error("fresh_payment_order_inactive");
  }
  if (deliveryDate) {
    const details = value(order, "Details");
    if (!Array.isArray(details) || !details.some(line =>
      String(value(line, "RequestedOn") ?? "").slice(0, 10) === deliveryDate.slice(0, 10) &&
      Number(value(line, "OpenQty")) > 0)) throw new Error("fresh_payment_delivery_changed");
  }
  return { unpaidBalance: Number(text), paymentTerms: terms,
    isPrepayment: ["PIF", "PP", "PPP", "PPT"].includes(terms), checkedAt: new Date().toISOString() };
}
