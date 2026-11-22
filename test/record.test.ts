import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import type { Agent } from "../src/agent.ts";
import { recordedModel, recordingPath, recordModel, type LiveModel } from "../src/model.ts";
import { runCase } from "../src/runner.ts";
import { spendCap, spendGuard } from "../src/spend.ts";
import { caseExpecting, tempDir, testBackend, verified } from "./helpers.ts";

const testCase = caseExpecting({ outcome: "resolved" }, { turns: ["Where is SC-1003?", "Thanks."] });

function fakeLive(cost_usd = 0.01): LiveModel & { calls: number } {
  const live = {
    calls: 0,
    async complete(request: unknown) {
      live.calls++;
      await sleep(5);
      return { response: { text: `reply ${live.calls} to ${JSON.stringify(request).length} characters` }, cost_usd };
    },
  };
  return live;
}

// Like a real model agent, it keeps one message list for the conversation and grows it after each call.
const chatAgent: Agent = {
  name: "chat",
  open({ model, tools }) {
    const messages: unknown[] = [];
    return async (history) => {
      messages.push(history.at(-1));
      let text = "";
      for (const step of ["plan", "answer"]) {
        const call = await model.complete({ step, messages });
        text = (call.response as { text: string }).text;
        messages.push(call.response);
      }
      await tools.call("lookup_order", verified("SC-1003"));
      return { text, status: "resolved" };
    };
  },
};

test("a recorded conversation replays to the same turns, time and cost", async () => {
  const root = await tempDir();
  const file = recordingPath(root, chatAgent.name, "tuning", testCase.id);
  const recorder = recordModel(fakeLive(), file, spendGuard(join(root, ".artifacts", "spend.json"), 50));

  const live = await runCase(chatAgent, testCase, await testBackend(), { model: recorder });
  await recorder.save();
  const replayed = await runCase(chatAgent, testCase, await testBackend(), { model: recordedModel(file) });

  expect(replayed.turns).toEqual(live.turns);
  expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(4);
  const agentTurns = live.turns.filter((turn) => turn.role === "agent");
  expect(agentTurns.map((turn) => turn.cost_usd)).toEqual([0.02, 0.02]);
  for (const turn of agentTurns) expect(turn.duration_ms).toBeGreaterThan(0);
});

test("an agent that edits a model response changes nothing in the recording", async () => {
  const root = await tempDir();
  const file = join(root, "recording.json");
  const recorder = recordModel(fakeLive(), file, spendGuard(join(root, ".artifacts", "spend.json"), 50));

  const call = await recorder.complete({ step: "one" });
  (call.response as { text: string }).text = "edited";
  await recorder.save();

  expect(JSON.parse(await readFile(file, "utf8"))[0].response.text).toBe("reply 1 to 14 characters");
});

test("the recorder adds each call's reported cost to the running spend", async () => {
  const root = await tempDir();
  const spend = join(root, ".artifacts", "spend.json");
  const recorder = recordModel(fakeLive(0.25), join(root, "recording.json"), spendGuard(spend, 50));

  await recorder.complete({ step: "one" });
  await recorder.complete({ step: "two" });

  expect(JSON.parse(await readFile(spend, "utf8"))).toEqual({ spent_usd: 0.5 });
});

test("the guard refuses a live call once the recorded spend reaches the cap, in this run and the next", async () => {
  const root = await tempDir();
  const spend = join(root, ".artifacts", "spend.json");
  const live = fakeLive(0.03);
  const recorder = recordModel(live, join(root, "recording.json"), spendGuard(spend, 0.06));

  await recorder.complete({ step: 1 });
  await recorder.complete({ step: 2 });
  await expect(recorder.complete({ step: 3 })).rejects.toThrow("has reached the cap set by SPEND_CAP_USD");
  const nextRun = recordModel(live, join(root, "recording.json"), spendGuard(spend, 0.06));
  await expect(nextRun.complete({ step: 1 })).rejects.toThrow("no live call was made");

  expect(live.calls).toBe(2);
});

test("the cap defaults to 50 dollars and comes from SPEND_CAP_USD", () => {
  expect(spendCap({})).toBe(50);
  expect(spendCap({ SPEND_CAP_USD: "" })).toBe(50);
  expect(spendCap({ SPEND_CAP_USD: "12.5" })).toBe(12.5);
});

test("a cap that is not a number fails without printing the value", () => {
  expect(() => spendCap({ SPEND_CAP_USD: "sk-secret" })).toThrow("SPEND_CAP_USD must be a number");
  expect(() => spendCap({ SPEND_CAP_USD: "sk-secret" })).not.toThrow("sk-secret");
});
