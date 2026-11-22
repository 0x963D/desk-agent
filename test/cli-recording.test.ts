import { expect, test, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { main } from "../src/cli.ts";
import { testRepo } from "./helpers.ts";

const modelAgent = vi.hoisted(
  (): Agent => ({
    name: "model-backed",
    open: ({ model }) => async () => ({ text: String((await model.complete({})).response), status: "resolved" }),
  }),
);

vi.mock("../src/agents/index.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/agents/index.ts")>();
  return { ...real, agents: new Map([...real.agents, [modelAgent.name, modelAgent]]) };
});

test("a run stopped by a missing recording names the case and the recording path", async () => {
  const root = await testRepo();

  const run = main(["tune", "--agent", "model-backed"], root);

  await expect(run).rejects.toThrow("tuning/en-asks-for-a-person stopped the run");
  await expect(run).rejects.toThrow("recordings/model-backed/tuning/en-asks-for-a-person.json");
  await expect(run).rejects.toThrow("needs the maintainer's approval");
});
