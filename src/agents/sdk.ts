import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, Output, stepCountIs, type ModelMessage, type ToolContent, type ToolSet } from "ai";
import { z } from "zod";
import type { Agent } from "../agent.ts";
import { toolDefinitions } from "../mcp.ts";
import { ToolName } from "../shapes.ts";
import { contracts } from "../tools.ts";
import { ANTHROPIC_HEADERS, anthropicModel, type AnthropicModel } from "./anthropic.ts";
import { openaiModel, type OpenAIModel } from "./openai.ts";
import { MAX_ROUNDS } from "./plain.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

type Model =
  | { provider: "openai"; model: OpenAIModel }
  | { provider: "anthropic"; model: AnthropicModel };

const reply = Output.object({
  name: "agent_reply",
  schema: z.strictObject({
    reply: z.string(),
    status: z.enum(["open", "resolved", "refused"]),
  }),
});

const shopTools = Object.fromEntries(toolDefinitions.map(({ name, description, inputSchema }) => {
  const contract = contracts[ToolName.parse(name)];
  const { $schema: _, ...schema } = inputSchema;
  return [name, {
    description: description ?? contract.description,
    strict: false,
    inputSchema: jsonSchema(schema, {
      // The SDK tries {} for empty argument text. The shop contracts reject it, so we can
      // distinguish empty text from a JSON object and still let MCP handle object validation.
      validate(value) {
        const parsed = contract.input.safeParse(value);
        return parsed.success ? { success: true, value } : { success: false, error: parsed.error };
      },
    }),
  }];
})) satisfies ToolSet;

// Headers every request carries that the live clients set themselves or that change nothing.
const TRANSPORT_HEADERS = new Set(["authorization", "x-api-key", "content-type", "user-agent"]);

// The live clients send only the request body and their own fixed headers. A header the SDK
// asks for beyond those would be dropped on a live call, so it fails here, offline, instead.
function checkHeaders(provider: Model["provider"], init: RequestInit | undefined) {
  const expected: Record<string, string> = provider === "anthropic" ? ANTHROPIC_HEADERS : {};
  const asked = [...new Headers(init?.headers)].filter(([name]) => !TRANSPORT_HEADERS.has(name));
  const missing = asked.filter(([name, value]) => expected[name] !== value);
  if (missing.length > 0 || asked.length !== Object.keys(expected).length) {
    throw new Error(
      `the SDK asked for headers the ${provider} live client does not send: ${JSON.stringify(Object.fromEntries(asked))}`,
    );
  }
}

const Arguments = z.looseObject({});
const invalid = (message: string) => ({ ok: false, error: { code: "invalid_input", message } });

export function sdkAgent({ provider, model }: Model): Agent {
  return {
    name: `sdk-${model}`,
    liveModel: () => provider === "openai" ? openaiModel(model) : anthropicModel(model),
    open({ tools, model: client }) {
      // Only the live client authenticates. This fetch never sends an HTTP request.
      const options = {
        apiKey: "unused",
        fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("expected a JSON request body from the provider");
          checkHeaders(provider, init);
          const { response } = await client.complete(JSON.parse(init.body));
          return Response.json(response);
        },
      };
      const settings = provider === "openai"
        ? {
            model: createOpenAI(options).responses(model),
            // The SDK asks for a detailed reasoning summary by default. The plain agent asks for none,
            // so null keeps the two loops' requests alike and the summary's output tokens unbilled.
            providerOptions: { openai: { instructions: SYSTEM_PROMPT, reasoningEffort: "low", reasoningSummary: null, store: false } },
          }
        : {
            model: createAnthropic(options)(model),
            instructions: SYSTEM_PROMPT,
            providerOptions: { anthropic: { effort: "low", structuredOutputMode: "outputFormat" } },
          };
      const messages: ModelMessage[] = [];

      return async (history) => {
        const newest = history.at(-1);
        if (newest?.role !== "customer") throw new Error("the agent was called without a new customer turn");
        messages.push({ role: "user", content: newest.text });

        for (let round = 0; ; round++) {
          const final = round === MAX_ROUNDS;
          const result = await generateText({
            ...settings,
            messages,
            tools: shopTools,
            toolChoice: final ? "none" : "auto",
            stopWhen: stepCountIs(1),
            output: reply,
            maxRetries: 0,
          });
          messages.push(...result.responseMessages.filter((message) => message.role === "assistant"));
          if (result.toolCalls.length === 0) {
            const { reply: text, status } = result.output;
            return { text, status };
          }
          if (final) throw new Error("the model called a function in a request that forbade functions");

          const content: ToolContent = [];
          for (const call of result.toolCalls) {
            const name = ToolName.safeParse(call.toolName);
            const args = Arguments.safeParse(call.input);
            const output = !name.success
              ? invalid(`No function is named ${call.toolName}. Functions: ${ToolName.options.join(", ")}.`)
              : !args.success
                ? invalid("The arguments were not a JSON object. Call the function again with a JSON object.")
                : await tools.call(name.data, args.data);
            content.push({
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: "text", value: JSON.stringify(output) },
            });
          }
          messages.push({ role: "tool", content });
        }
      };
    },
  };
}
