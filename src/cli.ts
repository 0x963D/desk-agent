import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Agent } from "./agent.ts";
import { agents, DEFAULT_AGENT } from "./agents/index.ts";
import { createBackend } from "./backend.ts";
import { caseDir, loadShop, loadSplit, readConversations, writeJson } from "./files.ts";
import { grade, passed } from "./grade.ts";
import { appendLedger, gitState, hashCaseFiles, ledgerFile, readLedger } from "./ledger.ts";
import { recordedModel, recordingPath, recordModel, type Recorder } from "./model.ts";
import { runCase } from "./runner.ts";
import { Conversation, TestResult, type Split, type TestCase } from "./shapes.ts";
import { spendCap, spendFile, spendGuard } from "./spend.ts";
import { formatSummary, Summary, summarize } from "./summary.ts";

const USAGE =
  "usage: tune [--agent <name>] [--record] | score [--agent <name>] [--record] | regrade <run directory>";

type Graded = { results: TestResult[]; summary: Summary };

const shown = (root: string, path: string) => relative(root, path).replaceAll("\\", "/");

async function casesOf(root: string, split: Split) {
  const data = await loadSplit(root, split);
  if (data.cases.length === 0) {
    throw new Error(
      `no ${split} cases: ${shown(root, caseDir(root, split))} holds no case files. Write them as docs/writing-cases.md describes.`,
    );
  }
  return data;
}

function gradeAll(split: Split, cases: TestCase[], conversations: Conversation[]): Graded {
  const results = conversations.map((conversation) => {
    const testCase = cases.find((c) => c.id === conversation.case_id);
    if (!testCase) throw new Error(`the run holds ${conversation.case_id}, which is not a ${split} case`);
    return grade(testCase, conversation);
  });
  return { results, summary: summarize(split, cases, results) };
}

function report(root: string, dir: string, { results, summary }: Graded): string {
  const lines = results.map((result) => {
    const verdict = passed(result)
      ? `PASS  ${result.observed}`
      : `FAIL  ${[
          result.observed !== result.expected && `expected ${result.expected}, observed ${result.observed}`,
          ...result.failures.map((f) => `${f.kind}: ${f.detail}`),
        ]
          .filter(Boolean)
          .join("; ")}`;
    const blocked = result.blocked_attempts.length > 0 ? `  (blocked: ${result.blocked_attempts.join("; ")})` : "";
    return `  ${result.case_id.padEnd(32)} ${verdict}${blocked}`;
  });
  return [`agent: ${summary.agent}`, `run: ${shown(root, dir)}`, ...lines, "", formatSummary(summary)].join("\n");
}

async function newRunDir(parent: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(parent, `${stamp}-${randomBytes(2).toString("hex")}`);
  await mkdir(parent, { recursive: true });
  await mkdir(dir);
  return dir;
}

async function run(root: string, agent: Agent, split: Split, parent: string, record?: (file: string) => Recorder) {
  const [shop, { cases, orders }] = await Promise.all([loadShop(root), casesOf(root, split)]);
  const dir = await newRunDir(join(parent, agent.name));
  const conversations: Conversation[] = [];
  for (const testCase of cases) {
    const file = recordingPath(root, agent.name, split, testCase.id);
    const recorder = record?.(file);
    const conversation = await runCase(agent, testCase, createBackend({ shop, orders }, { outage: testCase.outage }), {
      model: recorder ?? recordedModel(file),
    });
    await recorder?.save();
    await writeJson(join(dir, "conversations", `${testCase.id}.json`), Conversation, conversation);
    conversations.push(conversation);
  }
  return { dir, graded: gradeAll(split, cases, conversations) };
}

async function save(dir: string, { results, summary }: Graded) {
  await writeJson(join(dir, "results.json"), TestResult.array(), results);
  await writeJson(join(dir, "summary.json"), Summary, summary);
}

async function scoredNote(root: string, dir: string): Promise<string | undefined> {
  const run = shown(root, dir);
  const entry = (await readLedger(root)).findLast((line) => line.run === run);
  if (!entry) {
    return `No line in ${shown(root, ledgerFile(root))} records this run, so it is not a scoring run.`;
  }
  if (entry.cases_sha256 === (await hashCaseFiles(root, "held-out"))) return undefined;
  return `The held-out cases have changed since this run was scored at ${entry.time}. This report grades the saved conversations against the cases as they read now, so its numbers can differ from the score in the ledger.`;
}

async function regrade(root: string, dir: string): Promise<string> {
  const conversations = await readConversations(dir);
  const splits = [...new Set(conversations.map((c) => c.split))];
  const [split] = splits;
  if (!split || splits.length > 1) {
    throw new Error(`${shown(root, dir)} must hold the conversations of one split`);
  }
  const { cases } = await casesOf(root, split);
  const printed = report(root, dir, gradeAll(split, cases, conversations));
  const note = split === "held-out" ? await scoredNote(root, dir) : undefined;
  return note ? `${printed}\n\n${note}` : printed;
}

export async function main(args: string[], root: string = process.cwd()): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { agent: { type: "string" }, record: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new Error(USAGE);
  }
  const [command, ...rest] = parsed.positionals;
  const name = parsed.values.agent ?? DEFAULT_AGENT;

  if (command === "regrade" && rest.length === 1 && parsed.values.agent === undefined && !parsed.values.record) {
    return regrade(root, resolve(root, rest[0]!));
  }
  if ((command !== "tune" && command !== "score") || rest.length > 0) throw new Error(USAGE);
  const agent = agents[name];
  if (!agent) throw new Error(`no agent named ${name}. Agents: ${Object.keys(agents).join(", ")}`);
  let record: ((file: string) => Recorder) | undefined;
  if (parsed.values.record) {
    if (!agent.liveModel) throw new Error(`${agent.name} declares no live model client, so it has nothing to record`);
    const live = agent.liveModel();
    const guard = spendGuard(spendFile(root), spendCap());
    record = (file) => recordModel(live, file, guard);
  }

  if (command === "tune") {
    const { dir, graded } = await run(root, agent, "tuning", join(root, "traces"), record);
    await save(dir, graded);
    return report(root, dir, graded);
  }
  const git = gitState(root);
  const cases_sha256 = await hashCaseFiles(root, "held-out");
  const { dir, graded } = await run(root, agent, "held-out", join(root, "results"), record);
  await appendLedger(root, {
    time: new Date().toISOString(),
    agent: agent.name,
    run: shown(root, dir),
    ...git,
    cases_sha256,
    summary: graded.summary,
  });
  await save(dir, graded);
  return report(root, dir, graded);
}

if (import.meta.main) {
  try {
    if (existsSync(".env")) process.loadEnvFile(".env");
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
