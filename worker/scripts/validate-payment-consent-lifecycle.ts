import assert from "node:assert/strict";
import { processDeliveryPrepaymentHoldJob } from "../src/lib/deliveryPrepaymentHold";
import { processDeliveryTenDayConfirmationJob } from "../src/lib/deliveryTenDayConfirmation";
import { verifyDeliveryPaymentWrite } from "../src/lib/deliveryPaymentWriteEligibility";

async function scenario(patch: { balance?: string; terms?: string; via?: string; with?: string; confirmed?: boolean;
  sms?: string; email?: string; allowed?: boolean; unavailable?: boolean; contactId?: string; operation?: "hold" | "clearance";
  source?: string; deliveryDate?: string; noConnection?: boolean; missingConfirmationField?: boolean } = {}) {
  const calls = { puts: 0, contacts: 0, checks: 0 };
  const id = patch.contactId ?? "fresh-contact";
  const client = {
    fetchDeliverySalesOrderFull: async () => [{ OrderType: { value: "SO" }, OrderNbr: { value: "TEST" },
      Status: { value: "Open" }, ContactID: { value: id }, Terms: { value: patch.terms ?? "PP" },
      Totals: { UnpaidBalance: { value: patch.balance ?? "250" } },
      Details: [{ RequestedOn: { value: "2030-01-15" }, OpenQty: { value: 1 } }],
      custom: { Document: { AttributeCONFIRMVIA: { value: patch.via ?? "WEB" },
        AttributeCONFIRMWTH: { value: patch.with ?? "Customer" }, AttributeONEWEEKCON: { value: patch.missingConfirmationField ? undefined : patch.confirmed ?? false } } } }],
    fetchDeliveryContactByContactId: async (requested: string) => {
      assert.equal(requested, id); calls.contacts++;
      return [{ ContactID: { value: id }, Phone1: { value: "8015550123" }, Email: { value: "test@example.invalid" },
        custom: { Contact: { AttributeCONTEXT: { value: patch.sms ?? "Opt-in" },
          AttributeCONEMAIL: { value: patch.email ?? "Opt-out" } } } }];
    },
    fetchDeliveryPrepaymentHoldStates: async () => [{ orderType: "SO", orderNumber: "TEST", holdExposed: true,
      hold: calls.puts > 0, status: calls.puts ? "On Hold" : "Open" }],
    putDeliveryPrepaymentHold: async () => { calls.puts++; return { status: 200, body: {} }; },
    fetchDeliveryTenDayConfirmationStates: async () => [{ id: "entity", orderType: "SO", orderNumber: "TEST",
      oneWeekConfirmed: calls.puts > 0, oneWeekConfirmedExposed: true }],
    putDeliveryTenDayConfirmation: async () => { calls.puts++; return { status: 200, body: {} }; },
  };
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.checks++;
    assert.equal(String(url), "https://delivery.invalid/delivery/api/internal/delivery-payment-eligibility");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-secret");
    assert.equal(JSON.parse(String(init?.body)).contactId, id);
    if (patch.unavailable) throw Error("mock lookup unavailable");
    return Response.json({ eligible: patch.allowed !== false, reason: patch.allowed === false ? "no_automated_channel_available" : "eligible" });
  };
  const verify: typeof verifyDeliveryPaymentWrite = (c, p, scope, operation, env) => verifyDeliveryPaymentWrite(c, p, scope, operation, env, fakeFetch);
  const scope = { orderType: "SO", orderNumber: "TEST", deliveryDate: patch.deliveryDate ?? "2030-01-15", dryRun: false };
  const env = patch.noConnection ? {} : { DELIVERY_APP_BASE_URL: "https://delivery.invalid/delivery", MLD_QUEUE_TOKEN: "test-secret" };
  const result = patch.operation === "clearance"
    ? await processDeliveryTenDayConfirmationJob({ ...scope, sourceInterval: patch.source ?? "DAY_10" }, client, env, verify)
    : await processDeliveryPrepaymentHoldJob({ ...scope, reason: "payment_not_received_by_deadline" }, client, env, verify);
  return { result, calls };
}

async function main() {
  for (const consent of [{}, { sms: "Opt-out", email: "Opt-in" }, { sms: "Opt-in", email: "Opt-in" }]) {
    const outcome = await scenario(consent);
    assert.equal(outcome.result.status, "succeeded"); assert.equal(outcome.calls.puts, 1);
  }
  for (const patch of [{ sms: "Opt-out" }, { sms: "" }, { allowed: false }, { confirmed: true },
    { via: "" }, { with: "" }, { missingConfirmationField: true }, { unavailable: true }, { noConnection: true }, { balance: "0" }, { balance: "2" }, { terms: "NET30" }]) {
    const outcome = await scenario(patch);
    assert.equal(outcome.calls.puts, 0, JSON.stringify(patch));
    assert.notEqual(outcome.result.status, "succeeded");
  }
  assert.equal((await scenario({ contactId: "newly-assigned-contact" })).calls.puts, 1);
  const eight = await scenario({ operation: "clearance", balance: "0", source: "DAY_8" });
  assert.equal(eight.result.reason, "clearance_source_not_allowed"); assert.equal(eight.calls.puts, 0);
  for (const source of ["DAY_14", "DAY_12", "DAY_10"]) {
    assert.equal((await scenario({ operation: "clearance", balance: "0", source })).result.status, "written");
  }
  for (const patch of [{ allowed: false }, { sms: "Opt-out" }, { with: "" }, { unavailable: true }, { balance: "25" }]) {
    const outcome = await scenario({ operation: "clearance", balance: "0", ...patch });
    assert.equal(outcome.calls.puts, 0, JSON.stringify(patch));
  }
  await assert.rejects(scenario({ deliveryDate: "2030-01-16" }), /delivery_changed/);
  console.log("Payment consent/write lifecycle passed: fresh contact, SMS/email consent, local opt-out refusal, both confirmations, paid/terms, lookup failure, no DAY_8 clearance. Fake ERP/HTTP only; zero live calls or writes.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
