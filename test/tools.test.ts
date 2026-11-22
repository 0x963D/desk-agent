import { expect, test } from "vitest";
import { z } from "zod";
import { createBackend } from "../src/backend.ts";
import { loadFixtures } from "../src/files.ts";
import { ToolName } from "../src/shapes.ts";
import { contracts } from "../src/tools.ts";
import { refundFor, ROOT } from "./helpers.ts";

const backend = async () => createBackend(await loadFixtures(ROOT));

test.each(ToolName.options)("%s takes an input that is a JSON Schema object", (name) => {
  const schema = z.toJSONSchema(contracts[name].input);

  expect(schema.type).toBe("object");
  expect(schema.required).not.toEqual([]);
});

test("an order lookup returns the order from the fixtures", async () => {
  const { tools } = await backend();

  expect(await tools.call("lookup_order", { order_id: "EX-1001" })).toMatchObject({
    ok: true,
    data: { customer_id: "C-1001", status: "shipped", tracking_number: "AWB7001" },
  });
});

test("an account lookup returns the customer from the fixtures", async () => {
  const { tools } = await backend();

  expect(await tools.call("lookup_account", { customer_id: "C-1002" })).toMatchObject({
    ok: true,
    data: { name: "Ioana Model", email: "ioana@example.com" },
  });
});

test("a lookup of something that does not exist answers not_found", async () => {
  const { tools } = await backend();

  expect(await tools.call("lookup_order", { order_id: "EX-9999" })).toEqual({
    ok: false,
    error: "not_found",
  });
});

test("an input that breaks the contract answers invalid_input and changes nothing", async () => {
  const { tools, state } = await backend();

  const result = await tools.call("request_approval", {
    order_id: "EX-1002",
    change: { kind: "delivery_change" },
  });

  expect(result).toEqual({ ok: false, error: "invalid_input" });
  expect(state().requests).toEqual([]);
});

test.each([
  ["refund", "EX-1002", true, "within_return_window"],
  ["refund", "EX-1003", false, "outside_return_window"],
  ["refund", "EX-1001", false, "not_delivered_yet"],
  ["delivery_change", "EX-1004", true, "not_shipped_yet"],
  ["delivery_change", "EX-1001", false, "already_shipped"],
])("policy for a %s on %s: allowed %s, %s", async (kind, order_id, allowed, reason) => {
  const { tools } = await backend();

  expect(await tools.call("check_policy", { kind, order_id })).toEqual({
    ok: true,
    data: { allowed, reason },
  });
});

test("a filed request stays on file as pending approval", async () => {
  const { tools, state } = await backend();

  const result = await tools.call("request_approval", refundFor("EX-1002"));

  expect(result).toEqual({ ok: true, data: { request_id: "R-1", status: "pending_approval" } });
  expect(state().requests).toEqual([refundFor("EX-1002")]);
});

test("handing over twice keeps the first handover", async () => {
  const { tools, state } = await backend();

  await tools.call("hand_over_to_human", { reason: "customer_asked", summary: "first" });
  await tools.call("hand_over_to_human", { reason: "out_of_scope", summary: "second" });

  expect(state().handover).toEqual({ reason: "customer_asked", summary: "first" });
});
