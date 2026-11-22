import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentReply } from "../src/agent.ts";
import { createBackend, type World } from "../src/backend.ts";
import { loadSplit } from "../src/files.ts";
import type { ModelClient } from "../src/model.ts";
import { TestCase, type Split } from "../src/shapes.ts";
import type { Tools } from "../src/tools.ts";

export const ROOT = join(import.meta.dirname, "..");
const TEST_REPO = join(import.meta.dirname, "fixtures");

export const tempDir = () => mkdtemp(join(tmpdir(), "desk-agent-"));

export async function testRepo(): Promise<string> {
  const root = await tempDir();
  await cp(TEST_REPO, root, { recursive: true });
  await cp(join(ROOT, "fixtures", "shop.yaml"), join(root, "fixtures", "shop.yaml"));
  return root;
}

const REPO = await testRepo();

export async function testSplit(split: Split = "tuning"): Promise<{ cases: TestCase[]; world: World }> {
  const { shop, cases, orders } = await loadSplit(REPO, split);
  return { cases, world: { shop, orders } };
}

export const testWorld = async (split: Split = "tuning") => (await testSplit(split)).world;

export const testBackend = async (options: { outage?: boolean } = {}) =>
  createBackend(await testWorld(), options);

const { orders: TUNING_ORDERS } = await loadSplit(REPO, "tuning");

export const verified = (order_id: string) => ({
  order_id,
  email: TUNING_ORDERS.find((order) => order.order_id === order_id)?.email ?? "",
});

export const request = (order_id: string, change: Record<string, unknown>) => ({
  ...verified(order_id),
  change,
});

type Step = (tools: Tools, model: ModelClient) => AgentReply | Promise<AgentReply>;

export function scripted(...steps: Step[]): Agent {
  return {
    name: "scripted",
    open({ tools, model }) {
      let next = 0;
      return async () => {
        const step = steps[next++];
        if (!step) throw new Error("the script has no reply for this turn");
        return step(tools, model);
      };
    },
  };
}

export function caseExpecting(
  expect: unknown,
  { turns = ["Hello"], outage = false }: { turns?: string[]; outage?: boolean } = {},
): TestCase {
  return TestCase.parse({
    id: "en-example",
    split: "tuning",
    language: "en",
    category: "order-status",
    summary: "A case built by a test.",
    outage,
    turns,
    expect,
  });
}
