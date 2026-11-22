import { randomUUID } from "node:crypto";
import type { Agent } from "./agent.ts";
import { connectInMemory } from "./mcp.ts";
import type { ModelClient } from "./model.ts";
import type { Conversation, TestCase, ToolCall, ToolName, Turn } from "./shapes.ts";
import { snapshot } from "./snapshot.ts";
import type { Tools } from "./tools.ts";
import { handoverOf } from "./trace.ts";

const noModel: ModelClient = {
  async complete() {
    throw new Error("this run gives the agent no model");
  },
};

function meter(model: ModelClient) {
  let calls = 0;
  let running = 0;
  let duration_ms = 0;
  let cost_usd = 0;
  return {
    client: {
      async complete(request) {
        running++;
        try {
          const call = await model.complete(request);
          calls++;
          duration_ms += call.duration_ms;
          cost_usd += call.cost_usd;
          return call;
        } finally {
          running--;
        }
      },
    } satisfies ModelClient,
    take() {
      if (running > 0) {
        throw new Error("the agent replied while a model call was still running. Await every model call within its turn.");
      }
      const taken = { calls, duration_ms, cost_usd };
      calls = duration_ms = cost_usd = 0;
      return taken;
    },
  };
}

export async function runCase(
  agent: Agent,
  testCase: TestCase,
  backend: Tools,
  options: { model?: ModelClient; now?: () => number } = {},
): Promise<Conversation> {
  const { model = noModel, now = () => performance.now() } = options;
  const conversation_id = randomUUID();
  const shop = await connectInMemory(backend);
  const calls: ToolCall[] = [];
  const tools: Tools = {
    async call<K extends ToolName>(name: K, input: unknown) {
      const sent = snapshot(input);
      const output = await shop.tools.call(name, sent);
      calls.push({ name, input: sent, output: snapshot(output) });
      return output;
    },
  };
  const metered = meter(model);

  const turns: Turn[] = [];
  try {
    const respond = await agent.open({ conversation_id, tools, model: metered.client });
    for (const text of testCase.turns) {
      turns.push({ role: "customer", text });
      const started = now();
      const reply = await respond(snapshot(turns));
      const elapsed = now() - started;
      const used = metered.take();
      turns.push({
        role: "agent",
        text: reply.text,
        status: reply.status,
        tool_calls: calls.splice(0),
        duration_ms: used.calls > 0 ? used.duration_ms : elapsed,
        cost_usd: used.cost_usd,
      });
      if (handoverOf(turns)) break;
    }
  } finally {
    await shop.close();
  }

  return {
    conversation_id,
    case_id: testCase.id,
    split: testCase.split,
    agent: agent.name,
    turns,
  };
}
