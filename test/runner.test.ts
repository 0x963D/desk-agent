import { expect, test } from "vitest";
import type { Agent } from "../src/agent.ts";
import { ruleBasedAgent } from "../src/agents/rule-based.ts";
import { createBackend } from "../src/backend.ts";
import { grade, passed } from "../src/grade.ts";
import { replayModel } from "../src/model.ts";
import { runCase } from "../src/runner.ts";
import { Conversation } from "../src/shapes.ts";
import type { Tools } from "../src/tools.ts";
import { caseExpecting, request, scripted, testBackend, testSplit, testWorld } from "./helpers.ts";

const resolved = { outcome: "resolved" };

test("the trace holds every turn with its tool calls, and the time and cost of its model calls", async () => {
  const agent = scripted(
    async (_, model) => {
      await model.complete({ turn: 1 });
      return { text: "Which order?", status: "open" };
    },
    async (tools, model) => {
      await model.complete({ turn: 2 });
      await tools.call("lookup_order", { order_id: "SC-1999", email: "x@example.com" });
      return { text: "Found nothing.", status: "refused" };
    },
  );
  const testCase = caseExpecting(resolved, { turns: ["Hi", "SC-1999"] });
  const model = replayModel([
    { request: { turn: 1 }, response: "", duration_ms: 900, cost_usd: 0.002 },
    { request: { turn: 2 }, response: "", duration_ms: 1500, cost_usd: 0.004 },
  ]);

  const conversation = await runCase(agent, testCase, await testBackend(), { model });

  expect(conversation).toMatchObject({ case_id: "en-example", split: "tuning", agent: "scripted" });
  expect(conversation.turns).toEqual([
    { role: "customer", text: "Hi" },
    { role: "agent", text: "Which order?", status: "open", tool_calls: [], duration_ms: 900, cost_usd: 0.002 },
    { role: "customer", text: "SC-1999" },
    {
      role: "agent",
      text: "Found nothing.",
      status: "refused",
      tool_calls: [
        {
          name: "lookup_order",
          input: { order_id: "SC-1999", email: "x@example.com" },
          output: { ok: false, error: { code: "not_found", message: expect.any(String) } },
        },
      ],
      duration_ms: 1500,
      cost_usd: 0.004,
    },
  ]);
});

test("a turn that makes no model call is timed by the runner and costs nothing", async () => {
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

test("an agent that edits the history it was handed changes nothing in the trace", async () => {
  const agent: Agent = {
    name: "eraser",
    open: ({ tools }) => {
      let turn = 0;
      return async (history) => {
        if (turn++ === 0) {
          await tools.call("file_request", request("SC-1005", { kind: "return" }));
          return { text: "That return window has closed.", status: "refused" };
        }
        for (const earlier of history) {
          if (earlier.role === "agent") earlier.tool_calls.length = 0;
          earlier.text = "";
        }
        return { text: "Anything else?", status: "refused" };
      };
    },
  };
  const testCase = caseExpecting({ outcome: "refused" }, { turns: ["Return SC-1005, please.", "Hello?"] });

  const conversation = await runCase(agent, testCase, await testBackend());

  expect(conversation.turns.map((turn) => turn.text)).toEqual([
    "Return SC-1005, please.",
    "That return window has closed.",
    "Hello?",
    "Anything else?",
  ]);
  expect(grade(testCase, conversation).blocked_attempts).toEqual(["return for SC-1005: window_closed"]);
});

test("a function call is recorded as it happened, whatever the agent does later with its input and output", async () => {
  const sent = request("SC-1005", { kind: "return" });
  const agent = scripted(async (tools) => {
    const answer = await tools.call("file_request", sent);
    sent.change = { kind: "cancellation" };
    if (!answer.ok) Object.assign(answer.error, { code: "invalid_input" });
    return { text: "That return window has closed.", status: "refused" };
  });

  const conversation = await runCase(agent, caseExpecting({ outcome: "refused" }), await testBackend());

  expect(conversation.turns[1]).toMatchObject({
    tool_calls: [
      {
        name: "file_request",
        input: request("SC-1005", { kind: "return" }),
        output: { ok: false, error: { code: "policy_denied", reason: "window_closed" } },
      },
    ],
  });
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
      await tools.call("file_request", request("SC-1004", { kind: "return" }));
      return { text: "Filed.", status: "resolved" };
    });
  const testCase = caseExpecting({ outcome: "resolved", requests: [{ kind: "return", order_id: "SC-1004" }] });

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
    await tools.call("file_request", request("SC-1001", { kind: "cancellation" }));
    await tools.call("hand_over", { reason: "staff_decision", summary: "Asked for a refund too." });
    await tools.call("hand_over", { reason: "complaint", summary: "Second call." });
    return { text: "Filed, and a colleague will follow up.", status: "open" };
  });
  const testCase = caseExpecting(
    {
      outcome: "handed_over",
      handover_reason: "staff_decision",
      requests: [{ kind: "cancellation", order_id: "SC-1001" }],
    },
    { turns: ["Cancel SC-1001 please.", "Hello?"] },
  );

  const saved = Conversation.parse(JSON.parse(JSON.stringify(await runCase(agent, testCase, answering))));

  expect(Object.keys(saved).sort()).toEqual(["agent", "case_id", "conversation_id", "split", "turns"]);
  expect(saved.turns).toHaveLength(2);
  expect(grade(testCase, saved)).toMatchObject({ observed: "handed_over", failures: [] });
});

test("during an outage the rule-based agent hands over as a system failure", async () => {
  const testCase = caseExpecting(
    { outcome: "handed_over", handover_reason: "system_failure" },
    { turns: ["Where is my order SC-1003? jonas.weber@example.com"], outage: true },
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
