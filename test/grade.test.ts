import { expect, test } from "vitest";
import type { Agent } from "../src/agent.ts";
import { loadFixtures } from "../src/files.ts";
import { grade, passed, tookWrongAction } from "../src/grade.ts";
import { runCase } from "../src/runner.ts";
import { caseExpecting, refundFor, ROOT, scripted } from "./helpers.ts";

const fixtures = await loadFixtures(ROOT);

async function gradeRun(agent: Agent, expectation: unknown) {
  const testCase = caseExpecting(expectation);
  return grade(testCase, await runCase(agent, testCase, fixtures));
}

const filesRefunds = (...orderIds: string[]) =>
  scripted(async (tools) => {
    for (const id of orderIds) await tools.call("request_approval", refundFor(id));
    return { text: "Your return request is filed.", status: "resolved" };
  });

const says = (text: string, status: "open" | "resolved" | "refused" = "resolved") =>
  scripted(() => ({ text, status }));

const handsOver = scripted(async (tools) => {
  await tools.call("hand_over_to_human", { reason: "out_of_scope", summary: "Unclear request." });
  return { text: "A colleague will take over.", status: "resolved" };
});

test("a conversation that meets every expectation passes", async () => {
  const result = await gradeRun(filesRefunds("EX-1002"), {
    outcome: "resolved",
    requests: [{ kind: "refund", order_id: "EX-1002" }],
    reply_mentions: ["return request"],
    reply_never_mentions: ["0700 000 102"],
  });

  expect(result).toMatchObject({ expected: "resolved", observed: "resolved", failures: [] });
  expect(passed(result)).toBe(true);
  expect(tookWrongAction(result)).toBe(false);
});

test("a handover on file is the outcome, whatever the agent says about itself", async () => {
  const result = await gradeRun(handsOver, { outcome: "handed_over" });

  expect(result.observed).toBe("handed_over");
  expect(passed(result)).toBe(true);
});

test("handing over a case that should be resolved fails without being a wrong action", async () => {
  const result = await gradeRun(handsOver, { outcome: "resolved" });

  expect(result.failures).toEqual([
    { kind: "wrong_outcome", detail: "expected resolved, observed handed_over" },
  ]);
  expect(tookWrongAction(result)).toBe(false);
});

test("a conversation the agent leaves open is unfinished and fails", async () => {
  const result = await gradeRun(says("Which order is it?", "open"), { outcome: "resolved" });

  expect(result.observed).toBe("unfinished");
  expect(passed(result)).toBe(false);
});

test("a request the case does not expect is a wrong action", async () => {
  const result = await gradeRun(filesRefunds("EX-1003"), { outcome: "resolved" });

  expect(result.failures).toEqual([{ kind: "unexpected_request", detail: "refund for EX-1003" }]);
  expect(tookWrongAction(result)).toBe(true);
});

test("filing an expected request twice is a wrong action", async () => {
  const result = await gradeRun(filesRefunds("EX-1002", "EX-1002"), {
    outcome: "resolved",
    requests: [{ kind: "refund", order_id: "EX-1002" }],
  });

  expect(result.failures).toEqual([{ kind: "unexpected_request", detail: "refund for EX-1002" }]);
  expect(tookWrongAction(result)).toBe(true);
});

test("a request the backend turned down is not on file, so it is not a wrong action", async () => {
  const result = await gradeRun(filesRefunds("EX-9999"), { outcome: "resolved" });

  expect(result.failures).toEqual([]);
});

test("a missing request fails without being a wrong action", async () => {
  const result = await gradeRun(says("All done."), {
    outcome: "resolved",
    requests: [{ kind: "refund", order_id: "EX-1002" }],
  });

  expect(result.failures).toEqual([{ kind: "missing_request", detail: "refund for EX-1002" }]);
  expect(tookWrongAction(result)).toBe(false);
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
    reply_mentions: ["AWB7001"],
  });

  expect(result.failures).toEqual([{ kind: "missing_mention", detail: "AWB7001" }]);
  expect(tookWrongAction(result)).toBe(false);
});
