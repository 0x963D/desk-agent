import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadShop, loadSplit } from "../src/files.ts";
import { PolicyTopic, Split } from "../src/shapes.ts";
import { ROOT, testRepo } from "./helpers.ts";

test.each(Split.options)(
  "every %s case and order in the repository keeps the contract in docs/writing-cases.md",
  async (split) => {
    await expect(loadSplit(ROOT, split)).resolves.toBeDefined();
  },
);

test("the shop file holds a Romanian and an English rule for every policy topic", async () => {
  const shop = await loadShop(ROOT);

  expect(shop.business_date).toBe("2026-11-20");
  for (const topic of PolicyTopic.options) {
    expect(shop.rules[topic].ro).toMatch(/[ăâîșț]/);
    expect(shop.rules[topic].en).not.toBe("");
  }
});

test("the runner's own cases and orders keep the contract", async () => {
  const root = await testRepo();

  const tuning = await loadSplit(root, "tuning");
  const heldOut = await loadSplit(root, "held-out");

  expect(tuning.cases.map((c) => c.id)).toContain("ro-retur-in-termen");
  expect(heldOut.orders.map((o) => o.order_id)).toEqual(["SC-2001", "SC-2002"]);
});

test("missing case folders and fixture files load as an empty split", async () => {
  const root = await testRepo();
  await rm(join(root, "cases"), { recursive: true });
  await rm(join(root, "fixtures", "held-out.yaml"));

  expect(await loadSplit(root, "held-out")).toMatchObject({ cases: [], orders: [] });
});

async function edit(root: string, path: string, from: string | RegExp, to: string) {
  const file = join(root, path);
  const text = await readFile(file, "utf8");
  const changed = text.replace(from, to);
  if (changed === text) throw new Error(`the edit of ${path} matched nothing`);
  await writeFile(file, changed);
}

const CASE = "cases/tuning/ro-retur-in-termen.yaml";
const ORDERS = "fixtures/tuning.yaml";

test.each<[string, string, string | RegExp, string, RegExp]>([
  ["an id that differs from the file name", CASE, "id: ro-retur-in-termen", "id: ro-retur", /must equal the file name/],
  ["an id that does not start with the language", CASE, "language: ro", "language: en", /starts with the language/],
  ["a split that differs from the folder", CASE, "split: tuning", "split: held-out", /sits in cases\/tuning/],
  ["an expected order missing from the split's fixture", CASE, "order_id: SC-1004", "order_id: SC-1999", /SC-1999.*does not hold/],
  ["an order number outside the split's range", ORDERS, "order_id: SC-1001", "order_id: SC-2500", /outside the tuning range/],
  ["a total that differs from the sum of the items", ORDERS, "total_ron: 350", "total_ron: 360", /sum of the item prices/],
  ["an order email outside example.com", ORDERS, "ana.lungu@example.com", "ana.lungu@mail.test", /example\.com/],
  ["an email in a message outside example.com", CASE, "irina.pavel@example.com", "irina@mail.test", /not at example\.com/],
  ["a handover reason on a case that is not handed over", CASE, "outcome: resolved", "outcome: resolved\n  handover_reason: complaint", /handover_reason/],
  ["a refused case that expects a request", CASE, "outcome: resolved", "outcome: refused", /requests/],
  ["a misspelled expectation", CASE, "reply_mentions:", "reply_mention:", /reply_mention/],
  ["an order delivered after the business date", ORDERS, "delivered_on: 2026-11-14", "delivered_on: 2026-11-21", /SC-1004.*after the business date 2026-11-20/],
  ["an order delivered before it was placed", ORDERS, "delivered_on: 2026-11-14", "delivered_on: 2026-11-06", /delivered_on.*placed_on/],
  ["a delivered order without a delivery date", ORDERS, "    delivered_on: 2026-11-14\n", "", /delivered_on/],
  ["a paid order with a tracking link", ORDERS, "status: paid\n", "status: paid\n    tracking_url: https://curier.example/track/X\n", /tracking_url/],
  ["more than four customer turns", CASE, /turns:\n/, "turns:\n  - a\n  - b\n  - c\n", /turns/],
])("%s is rejected and the error names the file", async (_, path, from, to, error) => {
  const root = await testRepo();
  await edit(root, path, from, to);

  const load = loadSplit(root, "tuning");

  await expect(load).rejects.toThrow(error);
  await expect(load).rejects.toThrow(path.split("/").at(-1)!);
});

test("a case may not expect the same kind twice for one order", async () => {
  const root = await testRepo();
  await edit(root, CASE, "      order_id: SC-1004\n", "      order_id: SC-1004\n    - kind: return\n      order_id: SC-1004\n");

  await expect(loadSplit(root, "tuning")).rejects.toThrow("at most once per order");
});
