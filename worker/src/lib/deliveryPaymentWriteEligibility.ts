import type { DeliveryPaymentBalanceClient, readFreshDeliveryPaymentBalance } from "./deliveryPaymentBalance";

export type PaymentWriteScope = { orderType: string; orderNumber: string; deliveryDate?: string; sourceInterval?: string };
type Client = DeliveryPaymentBalanceClient & {
  fetchDeliveryContactByContactId?: (id: string) => Promise<Record<string, unknown>[]>;
};
type Payment = Awaited<ReturnType<typeof readFreshDeliveryPaymentBalance>>;

function value(record: Record<string, unknown>, name: string): unknown {
  const raw = record[name];
  return raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
}
function optIn(contact: Record<string, unknown>, name: string) {
  const fields = (contact.custom as { Contact?: Record<string, unknown> } | undefined)?.Contact;
  const raw = fields ? value(fields, name) : null;
  return raw === true || raw === 1 || ["opt-in", "opt in", "optin", "true", "yes", "1"].includes(String(raw ?? "").trim().toLowerCase());
}

export async function verifyDeliveryPaymentWrite(
  client: Client, payment: Payment, scope: PaymentWriteScope, operation: "hold" | "clearance",
  env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch,
) {
  const denied = (reason: string) => ({ eligible: false, reason });
  if (operation === "clearance" && !["DAY_14", "DAY_12", "DAY_10"].includes(scope.sourceInterval ?? "")) return denied("clearance_source_not_allowed");
  if (!payment.confirmVia || !payment.confirmWith) return denied("six_week_confirmation_incomplete");
  if (!payment.oneWeekConfirmedExposed) return denied("one_week_confirmation_field_not_exposed");
  if (payment.oneWeekConfirmed) return denied("one_week_confirmation_already_true");
  if (!scope.deliveryDate || !payment.contactId || !client.fetchDeliveryContactByContactId) return denied("fresh_contact_or_delivery_missing");
  const rows = await client.fetchDeliveryContactByContactId(payment.contactId);
  if (rows.length !== 1 || String(value(rows[0], "ContactID")) !== payment.contactId) return denied("fresh_contact_not_unique");
  const row = rows[0];
  if (/^(inactive|closed|deleted)$/i.test(String(value(row, "Status") ?? ""))) return denied("contact_inactive");
  const contact = { smsOptIn: optIn(row, "AttributeCONTEXT"), emailOptIn: optIn(row, "AttributeCONEMAIL"),
    phone1: String(value(row, "Phone1") ?? ""), phone2: String(value(row, "Phone2") ?? ""), email: String(value(row, "Email") ?? "") };
  if (!(contact.smsOptIn && (contact.phone1 || contact.phone2)) && !(contact.emailOptIn && contact.email)) return denied("no_automated_channel_available");
  const base = env.DELIVERY_APP_BASE_URL?.trim().replace(/\/+$/, "");
  const token = env.MLD_QUEUE_TOKEN?.trim();
  if (!base || !token) return denied("delivery_eligibility_connection_missing");
  const url = new URL(`${base}/api/internal/delivery-payment-eligibility`);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return denied("delivery_eligibility_https_required");
  const response = await fetchImpl(url, { method: "POST", redirect: "error", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...scope, operation, contactId: payment.contactId, contact }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`delivery_eligibility_lookup_failed:${response.status}`);
  const result = await response.json() as { eligible?: boolean; reason?: string };
  return result.eligible === true ? { eligible: true, reason: "eligible" } : denied(result.reason ?? "delivery_eligibility_denied");
}
