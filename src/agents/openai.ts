import { z } from "zod";
import type { LiveModel } from "../model.ts";

// US dollars per million tokens at the Standard tier, for prompts up to 272K input tokens.
// Cache writes are the 30-minute rate, the default lifetime. Read on 2026-11-22.
export const PRICES = {
  "gpt-6-luna": {
    input: 0.1,
    cached_input: 0.01,
    cache_write: 0.125,
    output: 0.5,
    source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
  },
  "gpt-6.2-sol": {
    input: 2,
    cached_input: 0.1,
    cache_write: 2.5,
    output: 10,
    source: "https://developers.openai.com/api/docs/models/gpt-6.2-sol",
  },
} as const;
export type OpenAIModel = keyof typeof PRICES;

const LONG_CONTEXT_TOKENS = 272_000;

export const Usage = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  input_tokens_details: z.looseObject({
    cached_tokens: z.number().int().nonnegative().default(0),
    cache_write_tokens: z.number().int().nonnegative().default(0),
  }),
  output_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

export function costOf(model: OpenAIModel, usage: Usage): number {
  if (usage.input_tokens > LONG_CONTEXT_TOKENS) {
    throw new Error(`a call of ${usage.input_tokens} input tokens is above the long-context limit the price table covers`);
  }
  const price = PRICES[model];
  const { cached_tokens, cache_write_tokens } = usage.input_tokens_details;
  const ordinary = usage.input_tokens - cached_tokens - cache_write_tokens;
  const dollars =
    ordinary * price.input +
    cached_tokens * price.cached_input +
    cache_write_tokens * price.cache_write +
    usage.output_tokens * price.output;
  return dollars / 1_000_000;
}

const ApiError = z.looseObject({ error: z.looseObject({ message: z.string() }) });

// Sends a Responses API request body as given and returns the response body as given, so a
// recording holds the plain JSON that crossed the wire.
export function openaiModel(model: OpenAIModel): LiveModel {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is not set, in the environment or in .env, so no live call was made.");
  return {
    async complete(request) {
      const answer = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const body: unknown = await answer.json();
      if (!answer.ok) {
        const message = ApiError.safeParse(body).data?.error.message ?? "no error message";
        throw new Error(`OpenAI answered ${answer.status}: ${message}`);
      }
      const { usage } = z.looseObject({ usage: Usage }).parse(body);
      return { response: body, cost_usd: costOf(model, usage) };
    },
  };
}
