import { z } from "zod";
import type { Agent, AgentReply } from "../agent.ts";
import { toolDefinitions } from "../mcp.ts";
import { ToolName } from "../shapes.ts";
import { openaiModel, Usage, type OpenAIModel } from "./openai.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

// A Responses API item, kept as the JSON the API sent or will receive.
type Item = Record<string, unknown>;

// The most function-call rounds in one turn. Past it, the next request forbids functions,
// so the model has to reply.
export const MAX_ROUNDS = 6;

const Reply = z.strictObject({
  reply: z.string(),
  status: z.enum(["open", "resolved", "refused"]),
});

const { $schema: _, ...replySchema } = z.toJSONSchema(Reply);
const REPLY_FORMAT = { type: "json_schema", name: "agent_reply", strict: true, schema: replySchema };

export const TOOLS = toolDefinitions.map(({ name, description, inputSchema }) => {
  const { $schema: _, ...parameters } = inputSchema;
  return { type: "function", name, description, parameters, strict: false };
});

const FunctionCall = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

const Message = z.looseObject({
  type: z.literal("message"),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

const ModelResponse = z.looseObject({
  status: z.string(),
  incomplete_details: z.looseObject({ reason: z.string() }).nullish(),
  output: z.array(z.looseObject({ type: z.string() })),
  usage: Usage,
});

function replyOf(output: Item[]): AgentReply {
  const message = output.map((item) => Message.safeParse(item)).find((parsed) => parsed.success)?.data;
  const text = message?.content.find((part) => part.type === "output_text")?.text;
  if (text === undefined) throw new Error("the model answered with neither a function call nor a reply");
  const { reply, status } = Reply.parse(JSON.parse(text));
  return { text: reply, status };
}

const parsedArguments = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const invalid = (message: string) => ({ ok: false, error: { code: "invalid_input", message } });

export function plainAgent(model: OpenAIModel, effort: "none" | "low" | "medium" | "high"): Agent {
  return {
    name: `plain-${model}`,
    liveModel: () => openaiModel(model),
    open({ tools, model: client }) {
      const input: Item[] = [];

      const complete = async (final: boolean): Promise<Item[]> => {
        const request = {
          model,
          instructions: SYSTEM_PROMPT,
          input,
          tools: TOOLS,
          ...(final && { tool_choice: "none" }),
          text: { format: REPLY_FORMAT },
          reasoning: { effort },
          store: false,
        };
        const response = ModelResponse.parse((await client.complete(request)).response);
        if (response.status !== "completed") {
          throw new Error(`the model response ended ${response.status}: ${response.incomplete_details?.reason ?? "no reason given"}`);
        }
        input.push(...response.output);
        return response.output;
      };

      return async (history) => {
        // The runner calls once per customer turn, and the earlier turns are already in input.
        const newest = history.at(-1);
        if (newest?.role !== "customer") throw new Error("the agent was called without a new customer turn");
        input.push({ role: "user", content: newest.text });

        for (let round = 0; ; round++) {
          const final = round === MAX_ROUNDS;
          const output = await complete(final);
          const calls = output.flatMap((item) => FunctionCall.safeParse(item).data ?? []);
          if (calls.length === 0) return replyOf(output);
          if (final) throw new Error("the model called a function in a request that forbade functions");
          for (const call of calls) {
            const name = ToolName.safeParse(call.name);
            const args = parsedArguments(call.arguments);
            const result = !name.success
              ? invalid(`No function is named ${call.name}. Functions: ${ToolName.options.join(", ")}.`)
              : !args
                ? invalid("The arguments were not a JSON object. Call the function again with a JSON object.")
                : await tools.call(name.data, args);
            input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
          }
        }
      };
    },
  };
}
