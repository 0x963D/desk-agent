import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import type { Agent, AgentReply } from "../src/agent.ts";
import { grade } from "../src/grade.ts";
import { recordedModel, recordingPath, replayModel, type ModelCall, type ModelClient } from "../src/model.ts";
import { runCase } from "../src/runner.ts";
import type { AgentTurn } from "../src/shapes.ts";
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
      let text = "";
      for (const step of steps) text = String((await model.complete({ step })).response);
      return { text, status: "resolved" };
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

const recorded125: ModelCall[] = [
  { request: { n: 1 }, response: "a", duration_ms: 125, cost_usd: 0.02 },
  { request: { n: 2 }, response: "b", duration_ms: 125, cost_usd: 0.02 },
];

const callsTwice = (reply: object): Agent => ({
  name: "model-backed",
  open: ({ model }) => async () => {
    await model.complete({ n: 1 });
    await model.complete({ n: 2 });
    return reply as AgentReply;
  },
});

test.each([
  ["reports nothing", { text: "Done.", status: "resolved" }],
  ["claims it cost nothing", { text: "Done.", status: "resolved", usage: { duration_ms: 0, cost_usd: 0 } }],
])("an agent that %s is charged the time and cost of the model calls it made in the turn", async (_, reply) => {
  const conversation = await runCase(callsTwice(reply), testCase, await testBackend(), {
    model: replayModel(recorded125),
    now: () => 0,
  });

  expect(conversation.turns[1]).toMatchObject({ duration_ms: 250 });
  expect((conversation.turns[1] as AgentTurn).cost_usd).toBeCloseTo(0.04);
});

test("model calls made while the agent opens count in its first turn", async () => {
  const agent: Agent = {
    name: "model-backed",
    async open({ model }) {
      await model.complete({ n: 1 });
      return async () => {
        await model.complete({ n: 2 });
        return { text: "Done.", status: "resolved" };
      };
    },
  };

  const conversation = await runCase(agent, testCase, await testBackend(), { model: replayModel(recorded125) });

  expect(conversation.turns[1]).toMatchObject({ duration_ms: 250 });
});

test("an agent that replies while a model call is still running stops the run", async () => {
  const slow: ModelClient = {
    complete: () => new Promise((settle) => setTimeout(() => settle({ response: "", duration_ms: 1, cost_usd: 1 }), 50)),
  };
  const agent: Agent = {
    name: "model-backed",
    open: ({ model }) => async () => {
      void model.complete({});
      return { text: "Done.", status: "resolved" };
    },
  };

  await expect(runCase(agent, testCase, await testBackend(), { model: slow })).rejects.toThrow(
    "a model call was still running",
  );
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

test("the error a missing recording gives the agent names neither the case nor the file", async () => {
  const root = await tempDir();
  const file = recordingPath(root, "model-backed", "tuning", "ro-plata-ramburs");
  let seen = "";
  const agent: Agent = {
    name: "model-backed",
    open: ({ model }) => async () => {
      await model.complete({}).catch((error: unknown) => (seen = String(error)));
      return { text: "Sorry, something went wrong.", status: "refused" };
    },
  };

  await runCase(agent, testCase, await testBackend(), { model: recordedModel(file) });

  expect(seen).toContain("needs the maintainer's approval");
  expect(seen).not.toMatch(/ro-plata-ramburs|recordings|tuning|model-backed/);
  expect(seen).not.toContain(root);
});

test("a model call that differs from its recording fails instead of answering", async () => {
  await expect(run(["plan", "improvise"], replayModel(recording))).rejects.toThrow("does not match its recording");
});

test("a model call beyond the end of the recording fails", async () => {
  await expect(run(["plan", "answer", "answer"], replayModel(recording))).rejects.toThrow(
    "does not match its recording",
  );
});
