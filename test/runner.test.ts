import { expect, test } from "vitest";
import { loadFixtures } from "../src/files.ts";
import { runCase } from "../src/runner.ts";
import { caseExpecting, refundFor, ROOT, scripted } from "./helpers.ts";

const fixtures = await loadFixtures(ROOT);
const resolved = { outcome: "resolved" };

test("the trace holds every turn with its tool calls, time and cost", async () => {
  const agent = scripted(
    () => ({ text: "Which order?", status: "open", usage: { duration_ms: 900, cost_usd: 0.002 } }),
    async (tools) => {
      await tools.call("lookup_order", { order_id: "EX-9999" });
      await tools.call("request_approval", refundFor("EX-1002"));
      return { text: "Filed.", status: "resolved", usage: { duration_ms: 1500, cost_usd: 0.004 } };
    },
  );

  const conversation = await runCase(agent, caseExpecting(resolved, ["Hi", "EX-1002"]), fixtures);

  expect(conversation).toEqual({
    case_id: "example",
    agent: "scripted",
    turns: [
      { role: "customer", text: "Hi" },
      {
        role: "agent",
        text: "Which order?",
        status: "open",
        tool_calls: [],
        duration_ms: 900,
        cost_usd: 0.002,
      },
      { role: "customer", text: "EX-1002" },
      {
        role: "agent",
        text: "Filed.",
        status: "resolved",
        tool_calls: [
          {
            name: "lookup_order",
            input: { order_id: "EX-9999" },
            output: { ok: false, error: "not_found" },
          },
          {
            name: "request_approval",
            input: refundFor("EX-1002"),
            output: { ok: true, data: { request_id: "R-1", status: "pending_approval" } },
          },
        ],
        duration_ms: 1500,
        cost_usd: 0.004,
      },
    ],
    requests: [refundFor("EX-1002")],
    handover: null,
  });
});

test("an agent that reports no usage is timed by the runner and costs nothing", async () => {
  const ticks = [1000, 1250];
  const agent = scripted(() => ({ text: "Done.", status: "resolved" }));

  const conversation = await runCase(agent, caseExpecting(resolved), fixtures, () => ticks.shift()!);

  expect(conversation.turns[1]).toMatchObject({ duration_ms: 250, cost_usd: 0 });
});

test("the agent sees the conversation so far, ending with the newest customer turn", async () => {
  const seen: string[][] = [];
  const agent = {
    name: "listener",
    open: () => async (history: readonly { text: string }[]) => {
      seen.push(history.map((turn) => turn.text));
      return { text: "Noted.", status: "open" as const };
    },
  };

  await runCase(agent, caseExpecting(resolved, ["First", "Second"]), fixtures);

  expect(seen).toEqual([["First"], ["First", "Noted.", "Second"]]);
});

test("after a handover the customer's remaining turns are not played", async () => {
  const handover = { reason: "customer_asked", summary: "Wants a person." };
  const agent = scripted(async (tools) => {
    await tools.call("hand_over_to_human", handover);
    return { text: "A colleague will take over.", status: "open" };
  });

  const conversation = await runCase(agent, caseExpecting(resolved, ["Help", "Hello?"]), fixtures);

  expect(conversation.turns.map((turn) => turn.text)).toEqual(["Help", "A colleague will take over."]);
  expect(conversation.handover).toEqual(handover);
});

test("each conversation starts from the fixtures, not from the previous conversation", async () => {
  const fileRefund = () =>
    scripted(async (tools) => {
      await tools.call("request_approval", refundFor("EX-1002"));
      return { text: "Filed.", status: "resolved" };
    });

  await runCase(fileRefund(), caseExpecting(resolved), fixtures);
  const second = await runCase(fileRefund(), caseExpecting(resolved), fixtures);

  expect(second.requests).toEqual([refundFor("EX-1002")]);
});
