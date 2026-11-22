import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_ROUNDS } from "../src/agents/plain.ts";
import { SYSTEM_PROMPT } from "../src/agents/prompt.ts";
import { sdkAgent } from "../src/agents/sdk.ts";
import { toolDefinitions } from "../src/mcp.ts";
import { recordedModel, recordModel, type ModelClient } from "../src/model.ts";
import { runCase } from "../src/runner.ts";
import type { AgentTurn } from "../src/shapes.ts";
import { spendGuard } from "../src/spend.ts";
import { caseExpecting, tempDir, testBackend, verified } from "./helpers.ts";

const openaiUsage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 80 };
const anthropicUsage = { input_tokens: 1200, output_tokens: 80 };
const models = [
  { provider: "openai", model: "gpt-6-luna", key: "OPENAI_API_KEY" },
  { provider: "openai", model: "gpt-6.2-sol", key: "OPENAI_API_KEY" },
  { provider: "anthropic", model: "claude-haiku-5-5", key: "ANTHROPIC_API_KEY" },
  { provider: "anthropic", model: "claude-sonnet-5-5", key: "ANTHROPIC_API_KEY" },
] as const;

type WireRequest = {
  tools: { name: string }[];
  tool_choice?: unknown;
  input?: { type: string; output?: string }[];
  messages?: { content: { type: string; content?: string }[] }[];
};

function fakeModel(...script: object[]) {
  const requests: WireRequest[] = [];
  const client: ModelClient = {
    async complete(request) {
      requests.push(request as WireRequest);
      const response = script.shift();
      if (!response) throw new Error("the script has no more responses");
      return { response, duration_ms: 700, cost_usd: 0.0002 };
    },
  };
  return { client, requests };
}

function toolResults(request: WireRequest) {
  if (request.input) {
    return request.input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output!));
  }
  return request.messages!.flatMap((message) => message.content)
    .filter((part) => part.type === "tool_result").map((part) => JSON.parse(part.content!));
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => { throw new Error("the wire fixture must handle every model request"); });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test.each(models)("$model uses low effort, native structured output and the shop tools on the wire", async (config) => {
  const agent = sdkAgent(config);
  const { client, requests } = fakeModel(
    toolResponse(config, "lookup_order", verified("SC-1003"), 1),
    replyResponse(config, "Your order has shipped.", "resolved"),
  );
  const testCase = caseExpecting({ outcome: "resolved" }, { turns: ["Where is order SC-1003?"] });

  const conversation = await runCase(agent, testCase, await testBackend(), { model: client });

  expect(conversation.turns[1]).toMatchObject({
    status: "resolved", text: "Your order has shipped.", duration_ms: 1400, cost_usd: 0.0004,
    tool_calls: [{ name: "lookup_order", input: verified("SC-1003"), output: { ok: true, data: { order_id: "SC-1003" } } }],
  });
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request).toMatchObject({ model: config.model });
    expect(request.tools.map((tool) => tool.name)).toEqual(toolDefinitions.map((tool) => tool.name));
    if (config.provider === "openai") {
      expect(request).toMatchObject({
        instructions: SYSTEM_PROMPT, reasoning: { effort: "low" }, store: false,
        text: { format: { type: "json_schema", name: "agent_reply" } },
      });
    } else {
      expect(request).toMatchObject({
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        output_config: { effort: "low", format: { type: "json_schema" } },
      });
    }
  }
  expect(toolResults(requests[1]!)).toEqual([
    { ok: true, data: expect.objectContaining({ order_id: "SC-1003" }) },
  ]);
});

test.each([models[0], models[2]])("$model forbids tools after the round limit and resets it on the next turn", async (config) => {
  const calls = Array.from({ length: MAX_ROUNDS }, (_, round) =>
    toolResponse(config, "lookup_order", verified("SC-1003"), round + 1));
  const { client, requests } = fakeModel(...calls, replyResponse(config, "Could you clarify?", "open"),
    replyResponse(config, "Thanks.", "resolved"));
  const testCase = caseExpecting({ outcome: "resolved" }, { turns: ["Where is my order?", "That answers my question."] });

  const conversation = await runCase(sdkAgent(config), testCase, await testBackend(), { model: client });

  const forbidden = config.provider === "openai" ? "none" : { type: "none" };
  expect(requests).toHaveLength(MAX_ROUNDS + 2);
  expect(requests[MAX_ROUNDS]!.tool_choice).toEqual(forbidden);
  expect(requests.filter((_, index) => index !== MAX_ROUNDS).every((request) =>
    JSON.stringify(request.tool_choice) !== JSON.stringify(forbidden))).toBe(true);
  expect(conversation.turns[1]).toMatchObject({ tool_calls: expect.any(Array), status: "open" });
  expect((conversation.turns[1] as AgentTurn).tool_calls).toHaveLength(MAX_ROUNDS);
  expect(conversation.turns[3]).toMatchObject({ status: "resolved" });
});

test.each([models[0], models[2]])("$model answers unknown tools and non-object arguments with invalid_input", async (config) => {
  const { client, requests } = fakeModel(
    toolResponse(config, "missing_tool", {}, 1),
    toolResponse(config, "lookup_order", ["SC-1003"], 2),
    replyResponse(config, "I could not find the order.", "refused"),
  );
  const testCase = caseExpecting({ outcome: "refused" });

  const conversation = await runCase(sdkAgent(config), testCase, await testBackend(), { model: client });

  expect(conversation.turns[1]).toMatchObject({ status: "refused", tool_calls: [] });
  expect(toolResults(requests[2]!)).toEqual([
    { ok: false, error: { code: "invalid_input", message: expect.stringContaining("No function is named missing_tool.") } },
    { ok: false, error: { code: "invalid_input", message: expect.stringContaining("The arguments were not a JSON object.") } },
  ]);
});

test("blank OpenAI arguments get an invalid_input result without calling MCP", async () => {
  const config = models[0];
  const { client, requests } = fakeModel(
    toolResponse(config, "lookup_order", null, 1, ""), replyResponse(config, "Which order?", "open"),
  );

  const conversation = await runCase(sdkAgent(config), caseExpecting({ outcome: "resolved" }), await testBackend(), { model: client });

  expect(conversation.turns[1]).toMatchObject({ status: "open", tool_calls: [] });
  expect(toolResults(requests[1]!)).toEqual([
    { ok: false, error: { code: "invalid_input", message: expect.stringContaining("The arguments were not a JSON object.") } },
  ]);
});

test.each(models)("$model replays the recorded wire requests across customer turns and rejects a mismatch", async (config) => {
  const agent = sdkAgent(config);
  const testCase = caseExpecting({ outcome: "resolved" }, { turns: ["Where is my order?", "It's SC-1003."] });
  const { client, requests } = fakeModel(
    replyResponse(config, "What's your order number?", "open"),
    toolResponse(config, "lookup_order", verified("SC-1003"), 1),
    replyResponse(config, "It has shipped.", "resolved"),
  );
  const dir = await tempDir();
  const file = join(dir, "recording.json");
  const recorder = recordModel(client, file, spendGuard(join(dir, "spend.json"), 1));

  const recorded = await runCase(agent, testCase, await testBackend(), { model: recorder });
  await recorder.save();
  const replayed = await runCase(agent, testCase, await testBackend(), { model: recordedModel(file) });

  expect(replayed.conversation_id).not.toBe(recorded.conversation_id);
  expect(replayed.turns).toEqual(recorded.turns);
  for (const text of ["Where is my order?", "What's your order number?", "It's SC-1003."]) {
    expect(JSON.stringify(requests[2])).toContain(text);
  }
  expect(JSON.stringify(requests[2])).toContain(
    config.provider === "openai" ? "encrypted_reasoning_1" : "thinking_signature_1",
  );
  const changed = { ...testCase, turns: ["Can I return my order?"] };
  await expect(runCase(agent, changed, await testBackend(), { model: recordedModel(file) }))
    .rejects.toThrow("model call 1 does not match its recording");
});

test.each(models)("$model refuses to start a live client without its key", (config) => {
  vi.stubEnv(config.key, undefined);
  expect(() => sdkAgent(config).liveModel!()).toThrow(`${config.key} is not set`);
});

type Config = typeof models[number];

function toolResponse(config: Config, name: string, input: unknown, number: number, args = JSON.stringify(input)) {
  if (config.provider === "openai") {
    return {
      id: `resp_${number}`, model: config.model, status: "completed", usage: openaiUsage,
      output: [
        { type: "reasoning", id: `rs_${number}`, summary: [], encrypted_content: `encrypted_reasoning_${number}` },
        { type: "function_call", id: `fc_${number}`, call_id: `call_${number}`, name, arguments: args },
      ],
    };
  }
  return {
    id: `msg_${number}`, model: config.model, type: "message", role: "assistant", stop_reason: "tool_use", usage: anthropicUsage,
    content: [
      { type: "thinking", thinking: "I should look up the order.", signature: `thinking_signature_${number}` },
      { type: "tool_use", id: `toolu_${number}`, name, input },
    ],
  };
}

function replyResponse(config: Config, reply: string, status: AgentTurn["status"]) {
  const text = JSON.stringify({ reply, status });
  if (config.provider === "openai") {
    return {
      id: `resp_${status}`, model: config.model, status: "completed", usage: openaiUsage,
      output: [{ type: "message", id: `msg_${status}`, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    };
  }
  return {
    id: `msg_${status}`, model: config.model, type: "message", role: "assistant", stop_reason: "end_turn", usage: anthropicUsage,
    content: [{ type: "text", text }],
  };
}
