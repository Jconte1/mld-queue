import "dotenv/config";
import assert from "node:assert/strict";
import { AcumaticaClient } from "../src/lib/acumaticaClient";

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: `entity-${id}`, InventoryID: { value: id }, Description: { value: `Product ${id}` },
  DefaultPrice: { value: 125 }, MSRP: { value: 200 }, ItemClass: { value: "PLUMB-LOT" },
  PriceClass: { value: "P069" }, rowNumber: 1, ...overrides,
});

async function main() {
  const client = new AcumaticaClient() as any;
  let calls: string[] = [];
  const rows = [row("A"), row("B"), row("SLASH/ID"), row("STAR**ID"), row("O'HARE"),
    row("ITEM 1"), row("ITEM_1"), row("DESCRIPTION ALIAS", { Description: { value: "DESCRIPTION_ALIAS" } })];
  client.request = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const filter = u.searchParams.get("$filter");
    if (filter) {
      if (filter.startsWith("InventoryCD")) throw Object.assign(new Error("unsupported field"), { status: 500 });
      const ids = [...filter.matchAll(/InventoryID eq '((?:[^']|'')*)'/g)].map(match => match[1].replace(/''/g, "'"));
      return rows.filter(item => ids.includes(item.InventoryID.value)).reverse()
        .map((item, index) => ({ ...item, rowNumber: index + 1 }));
    }
    const id = decodeURIComponent(u.pathname.split("/").at(-1)!);
    const found = rows.find(item => item.InventoryID.value === id) ?? rows.find(item => item.InventoryID.value === id.replace(/_/g, " "));
    if (!found) throw Object.assign(new Error('Acumatica request failed: 500 {"exceptionMessage":"No entity satisfies the condition."}'), { status: 500 });
    return found;
  };
  const request = client.request;
  const compare = async (ids: string[]) => {
    calls = [];
    const before = await client.getStockItemsSequential([...new Set(ids.map(id => id.trim().toUpperCase()).filter(Boolean))]);
    const beforeCalls = calls.length;
    calls = [];
    const after = await client.getStockItems(ids);
    assert.deepEqual(after, before, `Result mismatch for ${ids.join(",")}`);
    return { beforeCalls, afterCalls: calls.length, after };
  };
  const ordinary = await compare([" b ", "A", "B", "MISSING"]);
  assert.equal(ordinary.afterCalls, 1);
  assert(ordinary.beforeCalls > ordinary.afterCalls);
  await compare(["SLASH/ID", "STAR**ID", "O'HARE"]);
  await compare(["ITEM_1", "DESCRIPTION_ALIAS", "ITEM 1"]);
  await compare(["A", "MISSING"]);
  assert.deepEqual(await client.getStockItems(["MISSING", "OTHER-MISSING"]), []);
  calls = [];
  assert.deepEqual(await client.getStockItems([]), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.getStockItems(["A", " a "]), [row("A")]);
  await assert.rejects(() => client.getStockItems(["MISSING"]), { name: "StockItemNotFoundError", status: 404 });

  for (const bulkResponse of ["not JSON", null, { error: "invalid" }, [row("UNREQUESTED")],
    [row("A"), row("A")], [row("A"), row("B"), row("A")]]) {
    client.request = async (url: string) => new URL(url).searchParams.get("$filter")?.includes(" or ")
      ? bulkResponse : request(url);
    assert.deepEqual(await client.getStockItems(["A", "B"]), [row("A"), row("B")]);
  }
  for (const status of [400, 401, 404, 429, 500]) {
    client.request = async (url: string) => {
      if (new URL(url).searchParams.get("$filter")?.includes(" or ")) {
        throw Object.assign(new Error("bulk failed"), { status });
      }
      return request(url);
    };
    assert.deepEqual(await client.getStockItems(["B", "A"]), [row("B"), row("A")]);
  }
  client.request = request;
  // The live asterisk-key endpoint can return HTTP 200 HTML, which legacy code silently drops.
  client.request = async (url: string) => !new URL(url).search && url.includes("STAR**ID")
    ? "<!DOCTYPE html><html>Not an API record</html>" : request(url);
  assert.deepEqual(await client.getStockItemsSequential(["STAR**ID", "A"]), [row("A")]);
  assert.deepEqual(await client.getStockItems(["STAR**ID", "A"]), [row("STAR**ID"), row("A")]);
  client.request = request;
  // Spaces-only and underscore-only stored IDs retain existing alias behavior.
  assert.deepEqual((await client.getStockItems(["DESCRIPTION_ALIAS", "A"]))[0].InventoryID, { value: "DESCRIPTION_ALIAS" });
  const longIds = Array.from({ length: 55 }, (_, index) => `LONG-${index}-${"X".repeat(70)}`);
  calls = [];
  assert.deepEqual(await client.getStockItems(longIds), []);
  assert(calls.length > 2);
  assert(calls.every(url => new URL(url).search.length - 1 <= 1800));
  assert(calls.every(url => (new URL(url).searchParams.get("$filter")?.match(/InventoryID eq/g)?.length ?? 0) <= 25));
  await compare([...Array.from({ length: 28 }, (_, index) => `MISSING-${index}`), "B", "A"]);
  // A very long single key in a multi-item request must fall back without changing missing semantics.
  assert.deepEqual(await client.getStockItems(["L".repeat(1900), "A"]), [row("A")]);
  console.log("PASS: exact result/order/field parity; found/partial/all-missing/single 404; duplicates/case/aliases/slashes/asterisks/quotes; malformed/ambiguous/error fallback; bounded query chunks; no network requests");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
