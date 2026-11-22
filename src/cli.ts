import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Agent } from "./agent.ts";
import { agents, DEFAULT_AGENT } from "./agents/index.ts";
import { createBackend } from "./backend.ts";
import { envFile } from "./env.ts";
import { caseDir, filesIn, loadSplit, readConversations, writeJson } from "./files.ts";
import { grade, passed } from "./grade.ts";
import {
  appendLedger,
  gitState,
  hashCaseFiles,
  ledgerFile,
  readLedger,
  scoredRunDir,
  type LedgerEntry,
} from "./ledger.ts";
import { recordedModel, recordingDir, recordingPath, recordModel, type Recorder } from "./model.ts";
import { reportTable, type ReportRow } from "./report.ts";
import { runCase } from "./runner.ts";
import { Conversation, TestResult, type Split, type TestCase } from "./shapes.ts";
import { spendCap, spendFile, spendGuard } from "./spend.ts";
import { formatSummary, Summary, summarize } from "./summary.ts";

const USAGE =
  "usage: tune [--agent <name>] [--record] | score [--agent <name>] [--record] | regrade <run directory> | replay | report [--markdown]";

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
  const { shop, cases, orders } = await casesOf(root, split);
  const dir = await newRunDir(join(parent, agent.name));
  const conversations: Conversation[] = [];
  for (const testCase of cases) {
    const file = recordingPath(root, agent.name, split, testCase.id);
    const recorder = record?.(file);
    const conversation = await runCase(agent, testCase, createBackend({ shop, orders }, { outage: testCase.outage }), {
      model: recorder ?? recordedModel(file),
    }).catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`${split}/${testCase.id} stopped the run: ${why} Its recording path is ${shown(root, file)}.`, {
        cause: error,
      });
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

async function tune(root: string, agent: Agent, record?: (file: string) => Recorder): Promise<string> {
  const { dir, graded } = await run(root, agent, "tuning", join(root, "traces"), record);
  await save(dir, graded);
  return report(root, dir, graded);
}

async function replay(root: string): Promise<string> {
  const reports: string[] = [];
  for (const agent of agents.values()) {
    const recordings = recordingDir(root, agent.name, "tuning");
    if (agent.liveModel && (await filesIn(recordings, ".json")).length === 0) {
      reports.push(
        `agent: ${agent.name}\nskipped: ${shown(root, recordings)} holds no recordings, so its tuning set cannot be replayed offline. Recording one calls a paid provider and needs the maintainer's approval.`,
      );
      continue;
    }
    reports.push(await tune(root, agent));
  }
  return reports.join("\n\n");
}

async function regradeScored(root: string, cases: TestCase[], entry: LedgerEntry): Promise<void> {
  const conversations = await readConversations(scoredRunDir(root, entry.run));
  if (conversations.length === 0) {
    throw new Error(`${entry.run}, the latest scored run of ${entry.agent}, holds no saved conversations`);
  }
  let regraded: Summary;
  try {
    regraded = gradeAll("held-out", cases, conversations).summary;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`${entry.run} cannot be graded again: ${why}`, { cause: error });
  }
  const fields = Object.keys(entry.summary) as (keyof Summary)[];
  const differ = fields.filter((field) => regraded[field] !== entry.summary[field]);
  if (differ.length === 0) return;
  const cause =
    entry.cases_sha256 === (await hashCaseFiles(root, "held-out"))
      ? "The held-out cases are the ones it was scored on, so the grader, the summary or the saved conversations have changed."
      : "The held-out cases have changed since it was scored, so the agent must be scored again before its numbers are reported.";
  throw new Error(
    `${entry.run} no longer agrees with its line in ${shown(root, ledgerFile(root))} of ${entry.time}: ${differ
      .map((field) => `${field} grades to ${regraded[field]} but the ledger records ${entry.summary[field]}`)
      .join("; ")}. ${cause}`,
  );
}

async function scoreReport(root: string, markdown: boolean): Promise<string> {
  const ledger = await readLedger(root);
  if (ledger.length === 0) {
    throw new Error(`no scoring run: ${shown(root, ledgerFile(root))} holds no line. pnpm score records one.`);
  }
  const { cases } = await casesOf(root, "held-out");
  const rows: ReportRow[] = [];
  for (const agent of new Set(ledger.map((entry) => entry.agent))) {
    const lines = ledger.filter((entry) => entry.agent === agent);
    const entry = lines.at(-1)!;
    await regradeScored(root, cases, entry);
    rows.push({ entry, scored: lines.length });
  }
  return reportTable(rows, { markdown });
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
      options: { agent: { type: "string" }, record: { type: "boolean" }, markdown: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new Error(USAGE);
  }
  const [command, ...rest] = parsed.positionals;
  const name = parsed.values.agent ?? DEFAULT_AGENT;
  const bare = (count: number) => rest.length === count && parsed.values.agent === undefined && !parsed.values.record;

  if (command === "report" && bare(0)) return scoreReport(root, parsed.values.markdown ?? false);
  if (parsed.values.markdown !== undefined) throw new Error(USAGE);
  if (command === "regrade" && bare(1)) return regrade(root, resolve(root, rest[0]!));
  if (command === "replay" && bare(0)) return replay(root);
  if ((command !== "tune" && command !== "score") || rest.length > 0) throw new Error(USAGE);
  const agent = agents.get(name);
  if (!agent) throw new Error(`no agent named ${name}. Agents: ${[...agents.keys()].join(", ")}`);
  let record: ((file: string) => Recorder) | undefined;
  if (parsed.values.record) {
    if (!agent.liveModel) throw new Error(`${agent.name} declares no live model client, so it has nothing to record`);
    const live = agent.liveModel();
    const guard = spendGuard(spendFile(root), spendCap());
    record = (file) => recordModel(live, file, guard);
  }

  if (command === "tune") return tune(root, agent, record);
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
    const env = envFile(process.cwd());
    if (env) process.loadEnvFile(env);
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
