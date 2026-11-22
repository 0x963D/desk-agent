import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import type { Agent } from "../src/agent.ts";
import { grade } from "../src/grade.ts";
import { recordedModel, recordingPath, replayModel, type ModelCall, type ModelClient } from "../src/model.ts";
import { runCase } from "../src/runner.ts";
import { caseExpecting, tempDir, testBackend } from "./helpers.ts";

const testCase = caseExpecting({ outcome: "resolved" });

const recording: ModelCall[] = [
  { request: { step: "plan" }, response: "look it up", duration_ms: 800, cost_usd: 0.002 },
  { request: { step: "answer" }, response: "All sorted.", duration_ms: 400, cost_usd: 0.001 },
];

const modelAgent = (steps: string[]): Agent => ({
  name: "model-backed",
  open({ model }) {
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

const run = async (steps: string[], model: ModelClient) =>
  runCase(modelAgent(steps), testCase, await testBackend(), { model });

test("time and cost captured in a recording reach the test result on replay", async () => {
  const conversation = await run(["plan", "answer"], replayModel(recording));

  const result = grade(testCase, conversation);

  expect(result.turn_ms).toEqual([1200]);
  expect(result.cost_usd).toBeCloseTo(0.003);
});

test("the runner hands the agent the recording of its case, read from recordings/<agent>/<split>/<case id>.json", async () => {
  const root = await tempDir();
  const file = recordingPath(root, "model-backed", "tuning", testCase.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(recording));

  const conversation = await run(["plan", "answer"], recordedModel(file));

  expect(file.replaceAll("\\", "/")).toMatch(/recordings\/model-backed\/tuning\/en-example\.json$/);
  expect(conversation.turns[1]).toMatchObject({ text: "All sorted.", duration_ms: 1200 });
});

test("two identical requests in one conversation replay as two different recorded calls", async () => {
  const same: ModelCall[] = [
    { request: { step: "ask" }, response: "first", duration_ms: 10, cost_usd: 0.01 },
    { request: { step: "ask" }, response: "second", duration_ms: 20, cost_usd: 0.02 },
  ];

  const conversation = await run(["ask", "ask"], replayModel(same));

  expect(conversation.turns[1]).toMatchObject({ text: "second", duration_ms: 30, cost_usd: 0.03 });
});

test("a missing recording fails and says that recording one is a paid call", async () => {
  const file = recordingPath(await tempDir(), "model-backed", "tuning", testCase.id);

  await expect(run(["plan"], recordedModel(file))).rejects.toThrow("needs the maintainer's approval");
});

test("a model call that differs from its recording fails instead of answering", async () => {
  await expect(run(["plan", "improvise"], replayModel(recording))).rejects.toThrow("does not match its recording");
});

test("a model call beyond the end of the recording fails", async () => {
  await expect(run(["plan", "answer", "answer"], replayModel(recording))).rejects.toThrow(
    "does not match its recording",
  );
});
