import { afterEach, expect, test, vi } from "vitest";
import { anthropicModel, costOf } from "../src/agents/anthropic.ts";

const priced = {
  input_tokens: 2_000,
  cache_read_input_tokens: 6_000,
  cache_creation_input_tokens: 2_000,
  output_tokens: 1_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("the live client posts the Messages body as given and prices each usage category", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  const body = { id: "msg_1", type: "message", role: "assistant", content: [], usage: priced };
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  const request = { model: "claude-haiku-5-5", messages: [{ role: "user", content: "Salut" }] };

  const answer = await anthropicModel("claude-haiku-5-5").complete(request);

  expect(answer.response).toEqual(body);
  expect(answer.cost_usd).toBeCloseTo(0.00101, 10);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  expect(costOf("claude-sonnet-5-5", priced)).toBeCloseTo(0.0196, 10);
  expect(costOf("claude-opus-5-5", priced)).toBeCloseTo(0.0392, 10);
});

test("uncached usage prices ordinary input and output when cache counters are absent", () => {
  expect(costOf("claude-sonnet-5-5", { input_tokens: 2_000, output_tokens: 1_000 })).toBeCloseTo(0.014, 10);
});

test("Haiku's 100K tier counts ordinary, cache-read and cache-write input", () => {
  const boundary = { ...priced, input_tokens: 92_000 };
  expect(costOf("claude-haiku-5-5", boundary)).toBeCloseTo(0.01001, 10);
  expect(() => costOf("claude-haiku-5-5", { ...boundary, input_tokens: 92_001 })).toThrow("100001 input tokens");
});

test("the live client surfaces the status and provider message on an HTTP error", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal("fetch", async () => Response.json({ error: { message: "Model unavailable" } }, { status: 404 }));

  await expect(anthropicModel("claude-haiku-5-5").complete({})).rejects.toThrow("Anthropic answered 404: Model unavailable");
});
