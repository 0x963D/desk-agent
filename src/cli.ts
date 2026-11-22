import { join } from "node:path";
import { ruleBasedAgent } from "./agents/rule-based.ts";
import { loadCases, loadFixtures, readJson, writeJson } from "./files.ts";
import { grade, passed } from "./grade.ts";
import { runCase } from "./runner.ts";
import { Conversation, Split, TestResult, type TestCase } from "./shapes.ts";
import { formatSummary, summarize } from "./summary.ts";

const USAGE = "usage: tune | score | regrade <tuning|held-out>";
const RUNS = { tune: "tuning", score: "held-out" } as const;
const agent = ruleBasedAgent;

export type Dirs = { root: string; out: string };

const savedTo = (dirs: Dirs, split: Split) => ({
  conversations: join(dirs.out, agent.name, split, "conversations.json"),
  results: join(dirs.out, agent.name, split, "results.json"),
});

async function gradeAndReport(
  dirs: Dirs,
  split: Split,
  cases: TestCase[],
  conversations: Conversation[],
): Promise<string> {
  const results = conversations.map((conversation) => {
    const testCase = cases.find((c) => c.id === conversation.case_id);
    if (!testCase) throw new Error(`no ${split} case with id ${conversation.case_id}`);
    return grade(testCase, conversation);
  });
  await writeJson(savedTo(dirs, split).results, TestResult.array(), results);
  const lines = results.map((result) => {
    const verdict = passed(result)
      ? `PASS  ${result.observed}`
      : `FAIL  ${result.failures.map((f) => `${f.kind}: ${f.detail}`).join("; ")}`;
    return `  ${result.case_id.padEnd(30)} ${verdict}`;
  });
  return [`agent: ${agent.name}`, ...lines, "", ...summarize(results).map(formatSummary)].join("\n");
}

async function run(dirs: Dirs, split: Split): Promise<string> {
  const [fixtures, cases] = await Promise.all([loadFixtures(dirs.root), loadCases(dirs.root, split)]);
  const conversations: Conversation[] = [];
  for (const testCase of cases) conversations.push(await runCase(agent, testCase, fixtures));
  await writeJson(savedTo(dirs, split).conversations, Conversation.array(), conversations);
  return gradeAndReport(dirs, split, cases, conversations);
}

async function regrade(dirs: Dirs, split: Split): Promise<string> {
  const [cases, conversations] = await Promise.all([
    loadCases(dirs.root, split),
    readJson(savedTo(dirs, split).conversations, Conversation.array()),
  ]);
  return gradeAndReport(dirs, split, cases, conversations);
}

export async function main(
  args: string[],
  dirs: Dirs = { root: process.cwd(), out: join(process.cwd(), "traces") },
): Promise<string> {
  const [command, ...rest] = args;
  if ((command === "tune" || command === "score") && rest.length === 0) {
    return run(dirs, RUNS[command]);
  }
  const split = Split.safeParse(rest[0]);
  if (command === "regrade" && rest.length === 1 && split.success) return regrade(dirs, split.data);
  throw new Error(USAGE);
}

if (import.meta.main) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
