import { expect, test } from "vitest";
import type { Agent } from "../src/agent.ts";
import { loadFixtures } from "../src/files.ts";
import { grade } from "../src/grade.ts";
import { replayModel, type ModelCall } from "../src/model.ts";
import { runCase } from "../src/runner.ts";
import { caseExpecting, ROOT } from "./helpers.ts";

const fixtures = await loadFixtures(ROOT);
const testCase = caseExpecting({ outcome: "resolved" });

const recording: ModelCall[] = [
  { request: { step: "plan" }, response: "look it up", duration_ms: 800, cost_usd: 0.002 },
  { request: { step: "answer" }, response: "All sorted.", duration_ms: 400, cost_usd: 0.001 },
];

const modelAgent = (steps: string[]): Agent => ({
  name: "model-backed",
  open() {
    const model = replayModel(recording);
    return async () => {
      const usage = { duration_ms: 0, cost_usd: 0 };
      let text = "";
      for (const step of steps) {
        const call = await model.complete({ step });
        usage.duration_ms += call.duration_ms;
        usage.cost_usd += call.cost_usd;
        text = String(call.response);
      }
      return { text, status: "resolved", usage };
    };
  },
});

test("time and cost captured in a recording reach the test result on replay", async () => {
  const conversation = await runCase(modelAgent(["plan", "answer"]), testCase, fixtures);

  const result = grade(testCase, conversation);

  expect(result.turn_ms).toEqual([1200]);
  expect(result.cost_usd).toBeCloseTo(0.003);
});

test("a model call that differs from its recording fails instead of answering", async () => {
  const run = runCase(modelAgent(["plan", "improvise"]), testCase, fixtures);

  await expect(run).rejects.toThrow("does not match its recording");
});

test("a model call beyond the end of the recording fails", async () => {
  const run = runCase(modelAgent(["plan", "answer", "answer"]), testCase, fixtures);

  await expect(run).rejects.toThrow("does not match its recording");
});
