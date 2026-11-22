import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentReply } from "../src/agent.ts";
import { TestCase } from "../src/shapes.ts";
import type { Tools } from "../src/tools.ts";

export const ROOT = join(import.meta.dirname, "..");

export const tempDir = () => mkdtemp(join(tmpdir(), "fde-agent-"));

export async function copyOfRepoData(): Promise<string> {
  const root = await tempDir();
  await cp(join(ROOT, "cases"), join(root, "cases"), { recursive: true });
  await cp(join(ROOT, "fixtures"), join(root, "fixtures"), { recursive: true });
  return root;
}

type Step = (tools: Tools) => AgentReply | Promise<AgentReply>;

export function scripted(...steps: Step[]): Agent {
  return {
    name: "scripted",
    open({ tools }) {
      let next = 0;
      return async () => {
        const step = steps[next++];
        if (!step) throw new Error("the script has no reply for this turn");
        return step(tools);
      };
    },
  };
}

export function caseExpecting(expect: unknown, turns: string[] = ["Hello"]): TestCase {
  return TestCase.parse({
    id: "example",
    split: "tuning",
    language: "en",
    customer_id: "C-1002",
    summary: "A case built by a test.",
    turns,
    expect,
  });
}

export const refundFor = (order_id: string) => ({
  order_id,
  change: { kind: "refund", reason: "broken" },
});
