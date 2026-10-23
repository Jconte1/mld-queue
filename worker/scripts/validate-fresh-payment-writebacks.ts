import assert from "node:assert/strict";
import { processDeliveryPrepaymentHoldJob } from "../src/lib/deliveryPrepaymentHold";
import { processDeliveryTenDayConfirmationJob } from "../src/lib/deliveryTenDayConfirmation";

function client(balance: unknown, terms = "PP") {
  const calls = { reads: 0, holds: 0, confirmations: 0 };
  const api = {
    fetchDeliverySalesOrderFull: async () => {
      calls.reads++;
      return [{ OrderType: { value: "SO" }, OrderNbr: { value: "TEST" }, Status: { value: "Open" },
        Terms: { value: terms }, Totals: { UnpaidBalance: { value: balance } },
        Details: [{ RequestedOn: { value: "2030-01-15" }, OpenQty: { value: 1 } }] }];
    },
    fetchDeliveryPrepaymentHoldStates: async () => [{ orderType: "SO", orderNumber: "TEST",
      status: calls.holds ? "On Hold" : "Open", hold: Boolean(calls.holds), holdExposed: true }],
    putDeliveryPrepaymentHold: async () => { calls.holds++; return { status: 200, body: {} }; },
    fetchDeliveryTenDayConfirmationStates: async () => [{ id: "test-guid", orderType: "SO", orderNumber: "TEST",
      oneWeekConfirmed: Boolean(calls.confirmations), oneWeekConfirmedExposed: true }],
    putDeliveryTenDayConfirmation: async () => { calls.confirmations++; return { status: 200, body: {} }; },
  };
  return { api, calls };
}
const scope = { orderType: "SO", orderNumber: "TEST", deliveryDate: "2030-01-15", dryRun: false };
async function main() {
  for (const balance of ["0", "-25", "2.00"]) {
    const paid = client(balance);
    const skipped = await processDeliveryPrepaymentHoldJob({ ...scope, reason: "payment_not_received_by_deadline" }, paid.api, {});
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.reason, "payment_cleared_at_write");
    assert.equal(paid.calls.holds, 0);
    assert.equal(paid.calls.reads, 1);
    const cleared = await processDeliveryTenDayConfirmationJob(scope, paid.api, {});
    assert.equal(cleared.status, "written");
    assert.equal(paid.calls.confirmations, 1);
  }
  const due = client("25000");
  const refused = await processDeliveryTenDayConfirmationJob(scope, due.api, {});
  assert.equal(refused.status, "refused");
  assert.equal(due.calls.confirmations, 0);
  assert.equal((await processDeliveryPrepaymentHoldJob({ ...scope, reason: "payment_not_received_by_deadline" }, due.api, {})).status, "succeeded");
  assert.equal(due.calls.holds, 1);
  const nonPrepay = client("500", "NET30");
  assert.equal((await processDeliveryTenDayConfirmationJob(scope, nonPrepay.api, {})).status, "written");
  assert.equal((await processDeliveryPrepaymentHoldJob({ ...scope, reason: "payment_not_received_by_deadline" }, nonPrepay.api, {})).status, "skipped");
  assert.equal(nonPrepay.calls.holds, 0);
  for (const balance of [null, "", "invalid"]) {
    const broken = client(balance);
    await assert.rejects(processDeliveryTenDayConfirmationJob(scope, broken.api, {}), /balance_or_terms_missing/);
    await assert.rejects(processDeliveryPrepaymentHoldJob({ ...scope, reason: "payment_not_received_by_deadline" }, broken.api, {}), /balance_or_terms_missing/);
    assert.equal(broken.calls.holds + broken.calls.confirmations, 0);
  }
  const moved = client("25000");
  await assert.rejects(processDeliveryPrepaymentHoldJob({ ...scope, deliveryDate: "2030-01-16",
    reason: "payment_not_received_by_deadline" }, moved.api, {}), /delivery_changed/);
  assert.equal(moved.calls.holds, 0);
  const unavailable = client("0");
  unavailable.api.fetchDeliverySalesOrderFull = async () => { throw Error("ERP unavailable"); };
  await assert.rejects(processDeliveryTenDayConfirmationJob(scope, unavailable.api, {}), /ERP unavailable/);
  assert.equal(unavailable.calls.confirmations, 0);
  console.log("Fresh payment writebacks passed: paid-since-enqueue blocks hold, new balance blocks confirmation, threshold, non-prepay, moved delivery, failed reads. No live calls or writes.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
