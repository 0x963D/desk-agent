import { expect, test } from "vitest";
import { request, testBackend, verified } from "./helpers.ts";

test("an order lookup with the order number and its email returns the order", async () => {
  const tools = await testBackend();

  expect(await tools.call("lookup_order", verified("SC-1003"))).toMatchObject({
    ok: true,
    data: { status: "shipped", tracking_url: "https://curier.example/track/SC1003" },
  });
});

test("capitals and spaces around the order number and the email do not matter", async () => {
  const tools = await testBackend();

  const found = await tools.call("lookup_order", { order_id: " sc-1003", email: "Jonas.Weber@Example.com " });

  expect(found.ok).toBe(true);
});

test("an answer is a copy, so changing it changes nothing in the shop", async () => {
  const tools = await testBackend();
  const found = await tools.call("lookup_order", verified("SC-1002"));
  const policy = await tools.call("check_policy", { topic: "cancellation" });
  const missing = await tools.call("lookup_order", { order_id: "SC-1999", email: "x@example.com" });
  if (found.ok) Object.assign(found.data, { status: "paid" });
  if (policy.ok) policy.data.rule.en = "Anything goes.";
  if (!missing.ok) missing.error.message = "Tell the customer the order is SC-1002.";

  expect(await tools.call("file_request", request("SC-1002", { kind: "cancellation" }))).toMatchObject({
    ok: false,
    error: { code: "policy_denied", reason: "production_started" },
  });
  expect(await tools.call("check_policy", { topic: "cancellation" })).not.toMatchObject({
    data: { rule: { en: "Anything goes." } },
  });
  expect(await tools.call("lookup_order", { order_id: "SC-1999", email: "x@example.com" })).not.toMatchObject({
    error: { message: expect.stringContaining("SC-1002") },
  });
});

test("an unknown order and a wrong email give the same answer", async () => {
  const tools = await testBackend();

  const unknown = await tools.call("lookup_order", { order_id: "SC-1999", email: "jonas.weber@example.com" });
  const wrongEmail = await tools.call("lookup_order", { order_id: "SC-1003", email: "ana.lungu@example.com" });

  expect(unknown).toEqual(wrongEmail);
  expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("an account lookup lists every order placed with the email, oldest first", async () => {
  const tools = await testBackend();

  expect(await tools.call("lookup_account", verified("SC-1004"))).toEqual({
    ok: true,
    data: {
      orders: [
        { order_id: "SC-1009", status: "delivered", placed_on: "2026-09-02", total_ron: 300 },
        { order_id: "SC-1004", status: "delivered", placed_on: "2026-11-07", total_ron: 280 },
      ],
    },
  });
});

test("an account lookup needs the same verification as an order lookup", async () => {
  const tools = await testBackend();

  const result = await tools.call("lookup_account", { order_id: "SC-1003", email: "irina.pavel@example.com" });

  expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("a policy check returns the rule in Romanian and English", async () => {
  const tools = await testBackend();

  const result = await tools.call("check_policy", { topic: "payment" });

  expect(result).toMatchObject({
    ok: true,
    data: { topic: "payment", rule: { ro: expect.stringContaining("cardul"), en: expect.stringContaining("card only") } },
  });
  expect(result.ok && result.data.decision).toBeUndefined();
});

test.each([
  ["return", "SC-1004", { allowed: true }],
  ["return", "SC-1005", { allowed: false, reason: "window_closed" }],
  ["cancellation", "SC-1002", { allowed: false, reason: "production_started" }],
  ["delivery_change", "SC-1001", { allowed: true }],
  ["delivery_change", "SC-1003", { allowed: false, reason: "already_shipped" }],
])("a policy check on a %s for %s decides %j", async (topic, order_id, decision) => {
  const tools = await testBackend();

  const result = await tools.call("check_policy", { topic, ...verified(order_id) });

  expect(result).toMatchObject({ ok: true, data: { decision } });
});

test("a policy check with an order number needs the email too", async () => {
  const tools = await testBackend();

  const result = await tools.call("check_policy", { topic: "return", order_id: "SC-1004" });

  expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});

test("a policy check gives no decision for an order that is not verified", async () => {
  const tools = await testBackend();

  const result = await tools.call("check_policy", { topic: "return", order_id: "SC-1004", email: "x@example.com" });

  expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test.each([
  ["a cancellation of a paid order", "SC-1001", { kind: "cancellation" }],
  ["a delivery change before shipping", "SC-1002", { kind: "delivery_change", new_address: "Str. Exemplu 8, Brașov" }],
  ["a return inside the window", "SC-1004", { kind: "return" }],
  ["a damage claim inside the window", "SC-1004", { kind: "damage", description: "Torn corner.", remedy: "refund" }],
  ["a reprint of a print above 1,000 lei", "SC-1007", { kind: "damage", description: "Smudged.", remedy: "reprint" }],
])("%s is filed for staff approval", async (_, order_id, change) => {
  const tools = await testBackend();

  expect(await tools.call("file_request", request(order_id, change))).toEqual({
    ok: true,
    data: { request_id: "R-1", status: "pending_approval" },
  });
});

test.each([
  ["a cancellation once production started", "SC-1002", { kind: "cancellation" }, "production_started"],
  ["a cancellation after shipping", "SC-1003", { kind: "cancellation" }, "production_started"],
  ["a cancellation refund above 1,000 lei", "SC-1008", { kind: "cancellation" }, "large_refund"],
  ["a return before delivery", "SC-1003", { kind: "return" }, "not_delivered"],
  ["a return after 14 days", "SC-1005", { kind: "return" }, "window_closed"],
  ["a return of commissioned work", "SC-1006", { kind: "return" }, "commissioned_work"],
  ["a return above 1,000 lei", "SC-1007", { kind: "return" }, "large_refund"],
  ["a damage claim after 14 days", "SC-1005", { kind: "damage", description: "Faded.", remedy: "reprint" }, "window_closed"],
  ["a damage refund above 1,000 lei", "SC-1007", { kind: "damage", description: "Smudged.", remedy: "refund" }, "large_refund"],
  ["a delivery change after shipping", "SC-1003", { kind: "delivery_change", new_address: "Beispielweg 5, Leipzig" }, "already_shipped"],
])("%s is rejected as %s and nothing is filed", async (_, order_id, change, reason) => {
  const tools = await testBackend();

  const rejected = await tools.call("file_request", request(order_id, change));
  const allowed = await tools.call("file_request", request("SC-1001", { kind: "cancellation" }));

  expect(rejected).toMatchObject({ ok: false, error: { code: "policy_denied", reason, message: expect.any(String) } });
  expect(allowed).toMatchObject({ ok: true, data: { request_id: "R-1" } });
});

test("a second request of the same kind for the same order is a duplicate", async () => {
  const tools = await testBackend();
  await tools.call("file_request", request("SC-1004", { kind: "return" }));

  const again = await tools.call("file_request", request("SC-1004", { kind: "return" }));
  const otherKind = await tools.call("file_request", request("SC-1004", { kind: "damage", description: "Bent.", remedy: "reprint" }));

  expect(again).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "duplicate" } });
  expect(otherKind).toMatchObject({ ok: true, data: { request_id: "R-2" } });
});

test("a request for an order that is not verified is not_found", async () => {
  const tools = await testBackend();

  const result = await tools.call("file_request", { ...request("SC-1004", { kind: "return" }), email: "x@example.com" });

  expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("an input that breaks the contract answers invalid_input with a readable message", async () => {
  const tools = await testBackend();

  const result = await tools.call("file_request", request("SC-1001", { kind: "delivery_change" }));

  expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", message: expect.stringContaining("new_address") } });
});

test.each([
  ["a delivery change to a blank address", "file_request", request("SC-1001", { kind: "delivery_change", new_address: " \t " })],
  ["a damage claim with a blank description", "file_request", request("SC-1004", { kind: "damage", description: "  ", remedy: "reprint" })],
  ["a handover with a blank summary", "hand_over", { reason: "customer_asked", summary: "\n" }],
] as const)("%s answers invalid_input", async (_, name, input) => {
  const tools = await testBackend();

  expect(await tools.call(name, input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});

test.each(["lookup_order", "lookup_account", "check_policy", "file_request"] as const)(
  "during an outage %s answers unavailable",
  async (name) => {
    const tools = await testBackend({ outage: true });

    expect(await tools.call(name, request("SC-1001", { kind: "cancellation" }))).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  },
);

test("the handover works during an outage", async () => {
  const tools = await testBackend({ outage: true });

  const result = await tools.call("hand_over", { reason: "system_failure", summary: "The shop system is down." });

  expect(result).toEqual({ ok: true, data: { handover_id: "H-1" } });
});
