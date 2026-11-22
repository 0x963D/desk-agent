import { afterEach, expect, test, vi } from "vitest";
import { costOf, openaiModel } from "../src/agents/openai.ts";

const priced = {
  input_tokens: 10_000,
  input_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 2_000 },
  output_tokens: 1_000,
};

test("a call costs its ordinary, cached, cache-write and output tokens at the listed prices", () => {
  // gpt-6-luna: 2,000 × $0.10 + 6,000 × $0.01 + 2,000 × $0.125 + 1,000 × $0.50, per million tokens
  expect(costOf("gpt-6-luna", priced)).toBeCloseTo(0.00101, 10);
  // gpt-6.2-sol: 2,000 × $2 + 6,000 × $0.10 + 2,000 × $2.50 + 1,000 × $10, per million tokens
  expect(costOf("gpt-6.2-sol", priced)).toBeCloseTo(0.0196, 10);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("the live client refuses to start without a key", () => {
  vi.stubEnv("OPENAI_API_KEY", "");

  expect(() => openaiModel("gpt-6-luna")).toThrow("OPENAI_API_KEY is not set");
});

test("the live client posts the request as it is and prices the response from its usage", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  const body = { id: "resp_1", status: "completed", output: [], usage: priced };
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  const request = { model: "gpt-6-luna", input: [{ role: "user", content: "Salut" }] };

  const answer = await openaiModel("gpt-6-luna").complete(request);

  expect(answer.response).toEqual(body);
  expect(answer.cost_usd).toBeCloseTo(0.00101, 10);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.openai.com/v1/responses",
    expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
  );
});

test("the live client stops on an error answer and names the status and the provider's message", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubGlobal("fetch", async () => Response.json({ error: { message: "The model `gpt-x` does not exist" } }, { status: 404 }));

  await expect(openaiModel("gpt-6-luna").complete({})).rejects.toThrow("OpenAI answered 404: The model `gpt-x` does not exist");
});
