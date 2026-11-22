import { randomUUID } from "node:crypto";
import type { Agent } from "./agent.ts";
import { connectInMemory } from "./mcp.ts";
import type { ModelClient } from "./model.ts";
import type { Conversation, TestCase, ToolCall, ToolName, Turn } from "./shapes.ts";
import type { Tools } from "./tools.ts";
import { handoverOf } from "./trace.ts";

const noModel: ModelClient = {
  async complete() {
    throw new Error("this run gives the agent no model");
  },
};

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
      const output = await shop.tools.call(name, input);
      calls.push({ name, input, output });
      return output;
    },
  };

  const turns: Turn[] = [];
  try {
    const respond = await agent.open({ conversation_id, tools, model });
    for (const text of testCase.turns) {
      turns.push({ role: "customer", text });
      const started = now();
      const reply = await respond(turns);
      const elapsed = now() - started;
      turns.push({
        role: "agent",
        text: reply.text,
        status: reply.status,
        tool_calls: calls.splice(0),
        duration_ms: reply.usage?.duration_ms ?? elapsed,
        cost_usd: reply.usage?.cost_usd ?? 0,
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
