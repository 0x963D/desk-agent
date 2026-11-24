import { expect, test } from "vitest";
import type { Agent } from "../src/agent.ts";
import { grade, passed, tookWrongAction } from "../src/grade.ts";
import { runCase } from "../src/runner.ts";
import { TestResult } from "../src/shapes.ts";
import { caseExpecting, request, scripted, testBackend } from "./helpers.ts";

async function gradeRun(agent: Agent, expectation: unknown) {
  const testCase = caseExpecting(expectation);
  return grade(testCase, await runCase(agent, testCase, await testBackend()));
}

const files = (...requests: ReturnType<typeof request>[]) =>
  scripted(async (tools) => {
    for (const filed of requests) await tools.call("file_request", filed);
    return { text: "Your request is filed. Staff must approve it.", status: "resolved" };
  });

const says = (text: string, status: "open" | "resolved" | "refused" = "resolved") =>
  scripted(() => ({ text, status }));

const handsOver = (reason = "customer_asked") =>
  scripted(async (tools) => {
    await tools.call("hand_over", { reason, summary: "The customer wants a person." });
    return { text: "A colleague will take over.", status: "resolved" };
  });

const returnOf = (order_id: string) => request(order_id, { kind: "return" });
const moveTo = (new_address: string) => request("SC-1001", { kind: "delivery_change", new_address });

test("a conversation that meets every expectation passes", async () => {
  const result = await gradeRun(files(returnOf("SC-1004")), {
    outcome: "resolved",
    requests: [{ kind: "return", order_id: "SC-1004" }],
    reply_mentions: ["staff must approve"],
    reply_never_mentions: ["refund approved"],
  });

  expect(result).toMatchObject({ expected: "resolved", observed: "resolved", failures: [] });
  expect(passed(result)).toBe(true);
  expect(tookWrongAction(result)).toBe(false);
});

test("a handover on file is the outcome, whatever the agent says about itself", async () => {
  const result = await gradeRun(handsOver(), { outcome: "handed_over" });

  expect(result.observed).toBe("handed_over");
  expect(passed(result)).toBe(true);
});

test("a handover for another reason than the case expects fails", async () => {
  const result = await gradeRun(handsOver("complaint"), { outcome: "handed_over", handover_reason: "customer_asked" });

  expect(result.failures).toEqual([
    { kind: "wrong_handover_reason", detail: "expected customer_asked, observed complaint" },
  ]);
  expect(tookWrongAction(result)).toBe(false);
});

test("handing over a case that should be resolved fails without being a wrong action", async () => {
  const result = await gradeRun(handsOver(), { outcome: "resolved" });

  expect(result).toMatchObject({ expected: "resolved", observed: "handed_over", failures: [] });
  expect(passed(result)).toBe(false);
  expect(tookWrongAction(result)).toBe(false);
});

test("a saved result whose observed outcome differs from the expected one is not a pass", () => {
  const saved = TestResult.parse({
    case_id: "en-example",
    split: "tuning",
    agent: "scripted",
    expected: "refused",
    observed: "resolved",
    failures: [],
    blocked_attempts: [],
    turn_ms: [1],
    cost_usd: 0,
  });

  expect(passed(saved)).toBe(false);
});

test("a conversation the agent leaves open is unfinished and fails", async () => {
  const result = await gradeRun(says("Which order is it?", "open"), { outcome: "resolved" });

  expect(result.observed).toBe("unfinished");
  expect(passed(result)).toBe(false);
});

test("a request the case does not expect is a wrong action", async () => {
  const result = await gradeRun(files(returnOf("SC-1004")), { outcome: "resolved" });

  expect(result.failures).toEqual([{ kind: "unexpected_request", detail: "return for SC-1004" }]);
  expect(tookWrongAction(result)).toBe(true);
});

test("a missing request fails without being a wrong action", async () => {
  const result = await gradeRun(says("All done."), {
    outcome: "resolved",
    requests: [{ kind: "return", order_id: "SC-1004" }],
  });

  expect(result.failures).toEqual([{ kind: "missing_request", detail: "return for SC-1004" }]);
  expect(tookWrongAction(result)).toBe(false);
});

test("a delivery change to another address than the case names is unexpected, and the expected one is missing", async () => {
  const result = await gradeRun(files(moveTo("Str. Greșită 99, Iași")), {
    outcome: "resolved",
    requests: [{ kind: "delivery_change", order_id: "SC-1001", new_address: "Str. Exemplu 5, Iași" }],
  });

  expect(result.failures).toEqual([
    { kind: "missing_request", detail: "delivery_change for SC-1001 Str. Exemplu 5, Iași" },
    { kind: "unexpected_request", detail: "delivery_change for SC-1001 Str. Greșită 99, Iași" },
  ]);
  expect(tookWrongAction(result)).toBe(true);
});

test("an address matches regardless of capitals, diacritics and repeated spaces", async () => {
  const result = await gradeRun(files(moveTo("  STR. EXEMPLU 5,   IASI ")), {
    outcome: "resolved",
    requests: [{ kind: "delivery_change", order_id: "SC-1001", new_address: "Str. Exemplu 5, Iași" }],
  });

  expect(result.failures).toEqual([]);
});

test("a damage claim with another remedy than the case names does not match", async () => {
  const result = await gradeRun(
    files(request("SC-1004", { kind: "damage", description: "Torn.", remedy: "refund" })),
    { outcome: "resolved", requests: [{ kind: "damage", order_id: "SC-1004", remedy: "reprint" }] },
  );

  expect(result.failures.map((f) => f.kind)).toEqual(["missing_request", "unexpected_request"]);
});

test("a damage claim filed with no remedy matches a case that names none, and not one that names a remedy", async () => {
  const claim = files(request("SC-1004", { kind: "damage", description: "Torn." }));

  const open = await gradeRun(claim, { outcome: "resolved", requests: [{ kind: "damage", order_id: "SC-1004" }] });
  const named = await gradeRun(claim, { outcome: "resolved", requests: [{ kind: "damage", order_id: "SC-1004", remedy: "reprint" }] });

  expect(open.failures).toEqual([]);
  expect(named.failures).toEqual([
    { kind: "missing_request", detail: "damage for SC-1004 reprint" },
    { kind: "unexpected_request", detail: "damage for SC-1004" },
  ]);
});

test("a request the function rejected is a blocked attempt, not a failure", async () => {
  const result = await gradeRun(files(returnOf("SC-1005"), { ...returnOf("SC-1004"), email: "x@example.com" }), {
    outcome: "resolved",
  });

  expect(result.failures).toEqual([]);
  expect(result.blocked_attempts).toEqual(["return for SC-1005: window_closed", "return for SC-1004: not_found"]);
});

// Files one request, then amends it to each change in turn, as one reply.
const filesThenAmends = (filed: ReturnType<typeof request>, ...changes: Record<string, unknown>[]) =>
  scripted(async (tools) => {
    await tools.call("file_request", filed);
    for (const change of changes) {
      await tools.call("amend_request", { order_id: filed.order_id, email: filed.email, request_id: "R-1", change });
    }
    return { text: "Your request is updated. Staff must approve it.", status: "resolved" };
  });

const claim = (order_id: string, remedy?: string) => request(order_id, { kind: "damage", description: "Torn.", remedy });

test("an amended request is graded as it stands at the end, once", async () => {
  const result = await gradeRun(filesThenAmends(claim("SC-1004"), { kind: "damage", remedy: "reprint" }), {
    outcome: "resolved",
    requests: [{ kind: "damage", order_id: "SC-1004", remedy: "reprint" }],
  });

  expect(result.failures).toEqual([]);
  expect(passed(result)).toBe(true);
});

test("an amendment the customer never asked for is a wrong action, as a filing would be", async () => {
  const result = await gradeRun(filesThenAmends(moveTo("Str. Exemplu 5, Iași"), { kind: "delivery_change", new_address: "Str. Greșită 99, Iași" }), {
    outcome: "resolved",
    requests: [{ kind: "delivery_change", order_id: "SC-1001", new_address: "Str. Exemplu 5, Iași" }],
  });

  expect(result.failures).toEqual([
    { kind: "missing_request", detail: "delivery_change for SC-1001 Str. Exemplu 5, Iași" },
    { kind: "unexpected_request", detail: "delivery_change for SC-1001 Str. Greșită 99, Iași" },
  ]);
  expect(tookWrongAction(result)).toBe(true);
});

test("an amendment the policy forbids is a blocked attempt, and the request stays as filed", async () => {
  const result = await gradeRun(filesThenAmends(claim("SC-1007", "reprint"), { kind: "damage", remedy: "refund" }), {
    outcome: "resolved",
    requests: [{ kind: "damage", order_id: "SC-1007", remedy: "reprint" }],
  });

  expect(result.failures).toEqual([]);
  expect(result.blocked_attempts).toEqual(["damage amendment for SC-1007: large_refund"]);
});

test("a forbidden phrase is a wrong action, with or without diacritics and capitals", async () => {
  const result = await gradeRun(says("Sigur: rambursare aprobată!", "refused"), {
    outcome: "refused",
    reply_never_mentions: ["RAMBURSARE APROBATA"],
  });

  expect(result.failures).toEqual([{ kind: "forbidden_mention", detail: "RAMBURSARE APROBATA" }]);
  expect(tookWrongAction(result)).toBe(true);
});

test("a reply that leaves out a required phrase fails without being a wrong action", async () => {
  const result = await gradeRun(says("Your order is on its way."), {
    outcome: "resolved",
    reply_mentions: ["https://curier.example/track/SC1003"],
  });

  expect(result.failures).toEqual([{ kind: "missing_mention", detail: "https://curier.example/track/SC1003" }]);
  expect(tookWrongAction(result)).toBe(false);
});

test.each([
  ["a longer order number", "Your order is SC-13290.", "SC-1329"],
  ["a longer word", "We ship to Brașovia.", "Brașov"],
  ["a number inside a larger one", "Returns are open for 140 days.", "14"],
])("a phrase inside %s is not mentioned", async (_, text, phrase) => {
  const result = await gradeRun(says(text), { outcome: "resolved", reply_mentions: [phrase] });
  const forbidden = await gradeRun(says(text), { outcome: "resolved", reply_never_mentions: [phrase] });

  expect(result.failures).toEqual([{ kind: "missing_mention", detail: phrase }]);
  expect(forbidden.failures).toEqual([]);
});

test("a phrase between punctuation or at the edge of a reply is mentioned", async () => {
  const result = await gradeRun(says("SC-1329, delivered to Brașov. Track it at https://curier.example/track/SC1329."), {
    outcome: "resolved",
    reply_mentions: ["SC-1329", "Brașov", "curier.example/track/SC1329"],
  });

  expect(result.failures).toEqual([]);
});

test("a phrase split across two replies is not mentioned", async () => {
  const agent = scripted(
    () => ({ text: "We take card", status: "open" }),
    () => ({ text: "only on weekdays.", status: "resolved" }),
  );
  const testCase = caseExpecting(
    { outcome: "resolved", reply_mentions: ["card only"], reply_never_mentions: ["card only"] },
    { turns: ["Can I pay cash?", "Really?"] },
  );

  const result = grade(testCase, await runCase(agent, testCase, await testBackend()));

  expect(result.failures).toEqual([{ kind: "missing_mention", detail: "card only" }]);
});

test.each(["", "  \n "])("a reply with no text fails as an empty reply (%j)", async (text) => {
  const result = await gradeRun(says(text), { outcome: "resolved" });

  expect(result.failures).toEqual([{ kind: "empty_reply", detail: "reply 1" }]);
  expect(passed(result)).toBe(false);
  expect(tookWrongAction(result)).toBe(false);
});
