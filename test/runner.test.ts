import { expect, test } from "vitest";
import type { Agent } from "../src/agent.ts";
import { ruleBasedAgent } from "../src/agents/rule-based.ts";
import { createBackend } from "../src/backend.ts";
import { grade, passed } from "../src/grade.ts";
import { runCase } from "../src/runner.ts";
import { Conversation } from "../src/shapes.ts";
import type { Tools } from "../src/tools.ts";
import { caseExpecting, request, scripted, testBackend, testSplit, testWorld } from "./helpers.ts";

const resolved = { outcome: "resolved" };

test("the trace holds every turn with its tool calls, time and cost", async () => {
  const agent = scripted(
    () => ({ text: "Which order?", status: "open", usage: { duration_ms: 900, cost_usd: 0.002 } }),
    async (tools) => {
      await tools.call("lookup_order", { order_id: "AM-1999", email: "x@example.com" });
      return { text: "Found nothing.", status: "refused", usage: { duration_ms: 1500, cost_usd: 0.004 } };
    },
  );
  const testCase = caseExpecting(resolved, { turns: ["Hi", "AM-1999"] });

  const conversation = await runCase(agent, testCase, await testBackend());

  expect(conversation).toMatchObject({ case_id: "en-example", split: "tuning", agent: "scripted" });
  expect(conversation.turns).toEqual([
    { role: "customer", text: "Hi" },
    { role: "agent", text: "Which order?", status: "open", tool_calls: [], duration_ms: 900, cost_usd: 0.002 },
    { role: "customer", text: "AM-1999" },
    {
      role: "agent",
      text: "Found nothing.",
      status: "refused",
      tool_calls: [
        {
          name: "lookup_order",
          input: { order_id: "AM-1999", email: "x@example.com" },
          output: { ok: false, error: { code: "not_found", message: expect.any(String) } },
        },
      ],
      duration_ms: 1500,
      cost_usd: 0.004,
    },
  ]);
});

test("an agent that reports no usage is timed by the runner and costs nothing", async () => {
  const ticks = [1000, 1250];
  const agent = scripted(() => ({ text: "Done.", status: "resolved" }));

  const conversation = await runCase(agent, caseExpecting(resolved), await testBackend(), {
    now: () => ticks.shift()!,
  });

  expect(conversation.turns[1]).toMatchObject({ duration_ms: 250, cost_usd: 0 });
});

test("the agent sees the conversation so far, ending with the newest customer turn", async () => {
  const seen: string[][] = [];
  const agent: Agent = {
    name: "listener",
    open: () => async (history) => {
      seen.push(history.map((turn) => turn.text));
      return { text: "Noted.", status: "open" };
    },
  };

  await runCase(agent, caseExpecting(resolved, { turns: ["First", "Second"] }), await testBackend());

  expect(seen).toEqual([["First"], ["First", "Noted.", "Second"]]);
});

test("the agent receives an opaque conversation id that does not name the case", async () => {
  const ids: string[] = [];
  const agent: Agent = {
    name: "listener",
    open: ({ conversation_id }) => {
      ids.push(conversation_id);
      return async () => ({ text: "Noted.", status: "resolved" });
    },
  };
  const testCase = caseExpecting(resolved);

  const first = await runCase(agent, testCase, await testBackend());
  const second = await runCase(agent, testCase, await testBackend());

  expect(ids).toEqual([first.conversation_id, second.conversation_id]);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) {
    expect(id).not.toContain(testCase.id);
    expect(id).not.toContain("example");
  }
});

test("after a handover the customer's remaining turns are not played", async () => {
  const agent = scripted(async (tools) => {
    await tools.call("hand_over", { reason: "customer_asked", summary: "Wants a person." });
    return { text: "A colleague will take over.", status: "open" };
  });

  const conversation = await runCase(agent, caseExpecting(resolved, { turns: ["Help", "Hello?"] }), await testBackend());

  expect(conversation.turns.map((turn) => turn.text)).toEqual(["Help", "A colleague will take over."]);
});

test("each conversation starts from the fixtures, not from the previous conversation", async () => {
  const world = await testWorld();
  const fileReturn = () =>
    scripted(async (tools) => {
      await tools.call("file_request", request("AM-1004", { kind: "return" }));
      return { text: "Filed.", status: "resolved" };
    });
  const testCase = caseExpecting({ outcome: "resolved", requests: [{ kind: "return", order_id: "AM-1004" }] });

  await runCase(fileReturn(), testCase, createBackend(world));
  const second = await runCase(fileReturn(), testCase, createBackend(world));

  expect(passed(grade(testCase, second))).toBe(true);
});

test("effects are read from the trace, so a backend that only answers calls is enough", async () => {
  const answering: Tools = {
    async call(name) {
      const data = name === "file_request" ? { request_id: "X-7", status: "pending_approval" } : { handover_id: "X-8" };
      return { ok: true, data } as never;
    },
  };
  const agent = scripted(async (tools) => {
    await tools.call("file_request", request("AM-1001", { kind: "cancellation" }));
    await tools.call("hand_over", { reason: "staff_decision", summary: "Asked for a refund too." });
    await tools.call("hand_over", { reason: "complaint", summary: "Second call." });
    return { text: "Filed, and a colleague will follow up.", status: "open" };
  });
  const testCase = caseExpecting(
    {
      outcome: "handed_over",
      handover_reason: "staff_decision",
      requests: [{ kind: "cancellation", order_id: "AM-1001" }],
    },
    { turns: ["Cancel AM-1001 please.", "Hello?"] },
  );

  const saved = Conversation.parse(JSON.parse(JSON.stringify(await runCase(agent, testCase, answering))));

  expect(Object.keys(saved).sort()).toEqual(["agent", "case_id", "conversation_id", "split", "turns"]);
  expect(saved.turns).toHaveLength(2);
  expect(grade(testCase, saved)).toMatchObject({ observed: "handed_over", failures: [] });
});

test("during an outage the rule-based agent hands over as a system failure", async () => {
  const testCase = caseExpecting(
    { outcome: "handed_over", handover_reason: "system_failure" },
    { turns: ["Where is my order AM-1003? jonas.weber@example.com"], outage: true },
  );

  const conversation = await runCase(ruleBasedAgent, testCase, await testBackend({ outage: true }));

  expect(passed(grade(testCase, conversation))).toBe(true);
});

test("a two-turn Romanian return runs end to end through the rule-based agent", async () => {
  const { cases, world } = await testSplit();
  const testCase = cases.find((c) => c.id === "ro-retur-in-termen")!;

  const conversation = await runCase(ruleBasedAgent, testCase, createBackend(world));
  const result = grade(testCase, conversation);

  expect(conversation.turns.map((turn) => [turn.role, "status" in turn ? turn.status : ""])).toEqual([
    ["customer", ""],
    ["agent", "open"],
    ["customer", ""],
    ["agent", "resolved"],
  ]);
  expect(conversation.turns[3]?.text).toContain("Echipa trebuie să o aprobe");
  expect(result).toMatchObject({ observed: "resolved", failures: [], blocked_attempts: [] });
});
