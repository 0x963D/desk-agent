import type { Agent } from "./agent.ts";
import { createBackend, type Fixtures } from "./backend.ts";
import type { Conversation, TestCase, ToolCall, ToolName, Turn } from "./shapes.ts";
import type { Tools } from "./tools.ts";

export async function runCase(
  agent: Agent,
  testCase: TestCase,
  fixtures: Fixtures,
  now: () => number = () => performance.now(),
): Promise<Conversation> {
  const backend = createBackend(fixtures);
  const calls: ToolCall[] = [];
  const tools: Tools = {
    async call<K extends ToolName>(name: K, input: unknown) {
      const output = await backend.tools.call(name, input);
      calls.push({ name, input, output });
      return output;
    },
  };

  const respond = await agent.open({
    conversation_id: testCase.id,
    customer_id: testCase.customer_id,
    tools,
  });

  const turns: Turn[] = [];
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
    if (backend.state().handover) break;
  }

  return { case_id: testCase.id, agent: agent.name, turns, ...backend.state() };
}
