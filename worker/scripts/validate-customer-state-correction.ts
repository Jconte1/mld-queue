import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { processCustomerStateCorrectionJob, type CustomerStateCorrectionClient, type CustomerStateCorrectionInput } from "../src/lib/customerStateCorrection";
import { readCustomerStateWorkbook } from "./lib/customer-state-workbook";
import { csvLine, customerStateJobOutcome } from "./lib/customer-state-report";

const input: CustomerStateCorrectionInput = { customerId: "BA0000001", originalState: "84101", expectedState: "UT", apply: true,
  address: { AddressLine1: "1 Test St", AddressLine2: "", City: "Salt Lake City", Country: "US", PostalCode: "84101" } };
const v = (value: unknown) => ({ value });
const entity = () => ({ id: "11111111-1111-1111-1111-111111111111", CustomerID: v(input.customerId),
  MainContact: { id: "22222222-2222-2222-2222-222222222222", Address: {
    id: "33333333-3333-3333-3333-333333333333", ...Object.fromEntries(Object.entries(input.address).map(([key, value]) => [key, v(value)])), State: v(input.originalState),
  } } });

function fake(options: { ignorePut?: boolean; changePostal?: boolean; row?: ReturnType<typeof entity> } = {}) {
  const row = options.row ?? entity();
  const puts: Record<string, unknown>[] = [];
  const client: CustomerStateCorrectionClient = {
    fetchCustomerForStateCorrection: async () => structuredClone([row]),
    putCustomerStateCorrection: async payload => {
      puts.push(payload);
      const address = (payload.MainContact as { Address: { State: { value: string } } }).Address;
      if (!options.ignorePut) row.MainContact.Address.State = address.State;
      if (options.changePostal) (row.MainContact.Address as Record<string, unknown>).PostalCode = v("99999");
      return null;
    },
  };
  return { client, puts, row };
}

async function main() {
  const outcomes = [
    { status: "failed", result: null, error: 'Acumatica request failed: 422 {"error":"Missing sales person","CustomerName":"PRIVATE"}' },
    { status: "succeeded", result: { status: "updated", afterState: "ID" }, error: null },
  ].map(customerStateJobOutcome);
  assert.deepEqual(outcomes.map(value => value.outcome), ["failed", "updated"]);
  assert.ok(outcomes[0].error.includes("Missing sales person"));
  assert.ok(!outcomes[0].error.includes("PRIVATE"));
  assert.equal(csvLine(["BA0004470", 'Missing "AP", attribute', "=FORMULA()"]), '"BA0004470","Missing ""AP"", attribute","\'=FORMULA()"\r\n');
  globalThis.fetch = async () => { throw new Error("live_network_forbidden_in_validation"); };
  const apply = fake();
  const result = await processCustomerStateCorrectionJob(input, apply.client);
  assert.equal(result.status, "updated");
  assert.equal(apply.puts.length, 1);
  assert.deepEqual(apply.puts[0], { id: entity().id, MainContact: { id: entity().MainContact.id,
    Address: { id: entity().MainContact.Address.id, State: v("UT") } } });
  assert.equal((await processCustomerStateCorrectionJob(input, apply.client)).status, "already_correct");
  assert.equal(apply.puts.length, 1);
  const preview = fake();
  assert.equal((await processCustomerStateCorrectionJob({ ...input, apply: false }, preview.client)).status, "would_update");
  assert.equal(preview.puts.length, 0);
  const changed = fake(); changed.row.MainContact.Address.State = v("ID");
  assert.equal((await processCustomerStateCorrectionJob(input, changed.client)).status, "skipped_state_changed");
  assert.equal(changed.puts.length, 0);
  const moved = fake(); (moved.row.MainContact.Address as Record<string, unknown>).City = v("Boise");
  assert.equal((await processCustomerStateCorrectionJob(input, moved.client)).status, "skipped_address_changed");
  assert.equal(moved.puts.length, 0);
  const missing = fake(); delete (missing.row.MainContact.Address as Record<string, unknown>).State;
  await assert.rejects(processCustomerStateCorrectionJob(input, missing.client), /field_not_exposed/);
  assert.equal(missing.puts.length, 0);
  await assert.rejects(processCustomerStateCorrectionJob({ ...input, expectedState: "ZZ" }, fake().client), /invalid_expected_state/);
  await assert.rejects(processCustomerStateCorrectionJob({ ...input, apply: "true" }, fake().client), /invalid_customer_state_payload/);
  await assert.rejects(processCustomerStateCorrectionJob({ ...input, address: { ...input.address, Country: "CA" } }, fake().client), /only_us/);
  const ignored = fake({ ignorePut: true });
  await assert.rejects(processCustomerStateCorrectionJob(input, ignored.client), /verification_failed/);
  await assert.rejects(processCustomerStateCorrectionJob(input, fake({ changePostal: true }).client), /unexpected_address_change/);
  const wrong = fake(); wrong.row.CustomerID = v("WRONG");
  await assert.rejects(processCustomerStateCorrectionJob(input, wrong.client), /id_mismatch/);
  const ambiguous = fake(); ambiguous.client.fetchCustomerForStateCorrection = async () => [entity(), entity()];
  await assert.rejects(processCustomerStateCorrectionJob(input, ambiguous.client), /not_unique_or_missing/);
  const absent = fake(); absent.client.fetchCustomerForStateCorrection = async () => [];
  await assert.rejects(processCustomerStateCorrectionJob(input, absent.client), /not_unique_or_missing/);

  const temp = await mkdtemp(path.join(tmpdir(), "customer-state-validation-"));
  try {
    const file = path.join(temp, "fixture.xlsx");
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Data");
    sheet.addRow(["Customer ID", "EXPECTED STATE", "State", "Country", "Address Line 1", "Address Line 2", "City", "Postal Code"]);
    sheet.addRow([input.customerId, "UT", 84101, "US", "1 Test St", "", "Salt Lake City", "84101"]);
    await workbook.xlsx.writeFile(file);
    assert.equal((await readCustomerStateWorkbook(file))[0].originalState, "84101");
    sheet.addRow([input.customerId, "ID", 84101, "US", "1 Test St", "", "Salt Lake City", "84101"]);
    await workbook.xlsx.writeFile(file);
    await assert.rejects(readCustomerStateWorkbook(file), /duplicate Customer ID/);
    sheet.getRow(3).getCell(1).value = "BA0000002";
    sheet.getRow(3).getCell(2).value = { formula: '"UT"', result: "UT" };
    await workbook.xlsx.writeFile(file);
    await assert.rejects(readCustomerStateWorkbook(file), /unsupported cell type/);
  } finally {
    // Only remove this test's uniquely-created directory inside the OS temp folder.
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith("customer-state-validation-"));
    await rm(temp, { recursive: true });
  }
  console.log(JSON.stringify({ ok: true, previewWrites: 0, stateOnlyPayload: true, idempotentRerun: true,
    sourceDriftBlocked: true, readbackVerified: true, invalidWorkbookBlocked: true, actualErpCalls: 0, queueJobs: 0, databaseWrites: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
