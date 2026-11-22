import { z } from "zod";
import type { LiveModel } from "../model.ts";

// US dollars per million tokens at standard rates, with 5-minute cache writes. Read on 2026-11-23.
export const PRICES = {
  "claude-haiku-5-5": {
    input: 0.1,
    cached_input: 0.01,
    cache_write: 0.125,
    output: 0.5,
    max_input_tokens: 100_000,
    source: "https://platform.claude.com/docs/en/models/haiku-5-5/overview",
  },
  "claude-sonnet-5-5": {
    input: 2,
    cached_input: 0.1,
    cache_write: 2.5,
    output: 10,
    max_input_tokens: 1_000_000,
    source: "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
  },
  "claude-opus-5-5": {
    input: 4,
    cached_input: 0.2,
    cache_write: 5,
    output: 20,
    max_input_tokens: 1_000_000,
    source: "https://platform.claude.com/docs/en/models/opus-5-5/overview",
  },
} as const;
export type AnthropicModel = keyof typeof PRICES;

const Usage = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative(),
});
type Usage = z.infer<typeof Usage>;

export function costOf(model: AnthropicModel, usage: Usage): number {
  const price = PRICES[model];
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens + read + written;
  if (input > price.max_input_tokens) {
    throw new Error(`a call of ${input} input tokens is above the ${price.max_input_tokens}-token limit the price table covers`);
  }
  const dollars =
    usage.input_tokens * price.input +
    read * price.cached_input +
    written * price.cache_write +
    usage.output_tokens * price.output;
  return dollars / 1_000_000;
}

const ApiError = z.looseObject({ error: z.looseObject({ message: z.string() }) });

// The headers the AI SDK's Anthropic provider asks for. The SDK agent's fetch checks each
// request against them, so a provider upgrade that asks for others fails offline, not live.
export const ANTHROPIC_HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "structured-outputs-2025-11-13",
} as const;

export function anthropicModel(model: AnthropicModel): LiveModel {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set, in the environment or in .env, so no live call was made.");
  return {
    async complete(request) {
      const answer = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, ...ANTHROPIC_HEADERS, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const body: unknown = await answer.json();
      if (!answer.ok) {
        const message = ApiError.safeParse(body).data?.error.message ?? "no error message";
        throw new Error(`Anthropic answered ${answer.status}: ${message}`);
      }
      const { usage } = z.looseObject({ usage: Usage }).parse(body);
      return { response: body, cost_usd: costOf(model, usage) };
    },
  };
}
