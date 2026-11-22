import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Agent } from "./agent.ts";
import { agents, DEFAULT_AGENT } from "./agents/index.ts";
import { createBackend } from "./backend.ts";
import { auditAgreement } from "./agreement.ts";
import { chat, type ChatOutput } from "./chat.ts";
import { envFile } from "./env.ts";
import { caseDir, filesIn, loadSplit, readConversations, runName, writeJson } from "./files.ts";
import { grade, passed } from "./grade.ts";
import {
  appendLedger,
  codeOf,
  gitState,
  hashCaseFiles,
  hashCode,
  ledgerFile,
  readLedger,
  readLedgerCode,
  scoredRunDir,
  writeLedgerCode,
  type LedgerEntry,
} from "./ledger.ts";
import { recordedModel, recordingDir, recordingPath, recordModel, type Recorder } from "./model.ts";
import { writePacket } from "./packet.ts";
import { README_END, README_START, readmeTable, REPORTED_SETS, reportTable, runsTable, type ReportRow } from "./report.ts";
import { runCase } from "./runner.ts";
import { writeSheet } from "./sheet.ts";
import { Conversation, ScoredSet, TestResult, type Split, type TestCase } from "./shapes.ts";
import { spendCap, spendFile, spendGuard } from "./spend.ts";
import { formatSummary, Summary, summarize } from "./summary.ts";

const USAGE = [
  "usage: tune [--agent <name>] [--record] | score [--agent <name>] [--record] [--set held-out|final] | regrade <run directory> | replay | report [--markdown] | report --runs [--markdown] | report --check-readme | ledger-code | chat [--agent <name>] [--replay <tuning case id>]",
  "       | audit-packet --out <dir> --key <file> [--seed <text>] | audit-agreement --key <file> [--partial] <verdict file>...",
  "       | audit-sheet --packet <dir> --ids <file> --out <file.html>",
].join("\n");

// The terminal `pnpm chat` talks through. Standard input is opened only when a live chat reads it.
export type Terminal = { lines(): AsyncIterable<string>; interactive: boolean; output: ChatOutput };

const PROMPT = "customer  ";

const processTerminal: Terminal = {
  interactive: Boolean(process.stdin.isTTY),
  lines: async function* () {
    const typed = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY), prompt: PROMPT });
    try {
      if (process.stdin.isTTY) typed.prompt();
      for await (const line of typed) {
        yield line;
        if (process.stdin.isTTY) typed.prompt();
      }
    } finally {
      typed.close();
    }
  },
  output: { conversation: (line) => console.log(line), note: (line) => console.log(line) },
};

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
  const dir = join(parent, runName());
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

async function regradeScored(root: string, cases: TestCase[], entry: LedgerEntry): Promise<Graded> {
  const set = entry.summary.split;
  const conversations = await readConversations(scoredRunDir(root, entry.run));
  if (conversations.length === 0) {
    throw new Error(`${entry.run}, a scored run of ${entry.agent}, holds no saved conversations`);
  }
  let graded: Graded;
  try {
    graded = gradeAll(set, cases, conversations);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`${entry.run} cannot be graded again: ${why}`, { cause: error });
  }
  const regraded = graded.summary;
  const fields = Object.keys(entry.summary) as (keyof Summary)[];
  const differ = fields.filter((field) => regraded[field] !== entry.summary[field]);
  if (differ.length === 0) return graded;
  const cause =
    entry.cases_sha256 === (await hashCaseFiles(root, set))
      ? `The ${set} cases are the ones it was scored on, so the grader, the summary or the saved conversations have changed.`
      : `The ${set} cases have changed since it was scored, so the agent must be scored again before its numbers are reported.`;
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
  const code = await readLedgerCode(root);
  const tables: string[] = [];
  for (const set of REPORTED_SETS) {
    const scored = ledger.filter((entry) => entry.summary.split === set);
    if (scored.length === 0) continue;
    const { cases } = await casesOf(root, set);
    const rows: ReportRow[] = [];
    for (const agent of new Set(scored.map((entry) => entry.agent))) {
      const lines = scored.filter((entry) => entry.agent === agent);
      const latest = lines.at(-1)!;
      const latestCode = codeOf(latest, code);
      // A line whose code is unknown stands alone, because nothing shows that another run used the same code.
      const same =
        latestCode === undefined
          ? [latest]
          : lines.filter((entry) => entry.cases_sha256 === latest.cases_sha256 && codeOf(entry, code) === latestCode);
      const graded = await Promise.all(same.map((entry) => regradeScored(root, cases, entry)));
      const results = graded.flatMap((run) => run.results);
      rows.push({
        agent,
        runs: graded.map((run) => run.summary),
        turn_ms: results.flatMap((result) => result.turn_ms).sort((a, b) => a - b),
        cost_usd: results.reduce((total, result) => total + result.cost_usd, 0),
        code: latestCode,
        latest,
        scored: lines.length,
      });
    }
    tables.push(reportTable(set, rows, { markdown }));
  }
  return tables.join("\n\n");
}

async function runsReport(root: string, markdown: boolean): Promise<string> {
  const ledger = await readLedger(root);
  if (ledger.length === 0) {
    throw new Error(`no scoring run: ${shown(root, ledgerFile(root))} holds no line. pnpm score records one.`);
  }
  const code = await readLedgerCode(root);
  return runsTable(
    ledger.map((entry) => ({ entry, code: codeOf(entry, code) })),
    { markdown },
  );
}

async function checkReadme(root: string): Promise<string> {
  const file = join(root, "README.md");
  const inReadme = readmeTable(await readFile(file, "utf8"));
  if (inReadme === undefined) {
    throw new Error(`README.md holds no report table between the lines ${README_START} and ${README_END}`);
  }
  const current = await scoreReport(root, true);
  if (inReadme === current) return "README.md shows the current pnpm report --markdown table.";
  const readmeLines = inReadme.split("\n");
  const currentLines = current.split("\n");
  let first = 0;
  while (readmeLines[first] === currentLines[first]) first++;
  throw new Error(
    `the table in README.md is not the current pnpm report --markdown, so the README no longer shows the numbers the ledger and the saved runs give. Line ${first + 1} of the table reads ${JSON.stringify(readmeLines[first] ?? "")} where the report prints ${JSON.stringify(currentLines[first] ?? "")}. Put the output of pnpm report --markdown between the two marker lines.`,
  );
}

async function scoredNote(root: string, dir: string): Promise<string | undefined> {
  const run = shown(root, dir);
  const entry = (await readLedger(root)).findLast((line) => line.run === run);
  if (!entry) {
    return `No line in ${shown(root, ledgerFile(root))} records this run, so it is not a scoring run.`;
  }
  const set = entry.summary.split;
  if (entry.cases_sha256 === (await hashCaseFiles(root, set))) return undefined;
  return `The ${set} cases have changed since this run was scored at ${entry.time}. This report grades the saved conversations against the cases as they read now, so its numbers can differ from the score in the ledger.`;
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
  const note = split === "tuning" ? undefined : await scoredNote(root, dir);
  return note ? `${printed}\n\n${note}` : printed;
}

export async function main(args: string[], root: string = process.cwd(), terminal: Terminal = processTerminal): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        agent: { type: "string" },
        record: { type: "boolean" },
        markdown: { type: "boolean" },
        replay: { type: "string" },
        runs: { type: "boolean" },
        "check-readme": { type: "boolean" },
        out: { type: "string" },
        key: { type: "string" },
        seed: { type: "string" },
        partial: { type: "boolean" },
        packet: { type: "string" },
        ids: { type: "string" },
        set: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new Error(USAGE);
  }
  const [command, ...rest] = parsed.positionals;
  const { values } = parsed;
  // True when no option outside `allowed` was given.
  const only = (...allowed: string[]) => Object.keys(values).every((option) => allowed.includes(option));
  // True when the command got `count` positionals and no option outside `allowed`.
  const takes = (count: number, ...allowed: string[]) => rest.length === count && only(...allowed);

  if (command === "audit-packet" && values.out && values.key && takes(0, "out", "key", "seed")) {
    return writePacket(root, { out: resolve(root, values.out), key: resolve(root, values.key), seed: values.seed });
  }
  if (command === "audit-agreement" && values.key && rest.length > 0 && only("key", "partial")) {
    const files = rest.map((file) => resolve(root, file));
    return auditAgreement(root, resolve(root, values.key), files, { partial: values.partial ?? false });
  }
  if (command === "audit-sheet" && values.packet && values.ids && values.out && takes(0, "packet", "ids", "out")) {
    return writeSheet(root, { packet: resolve(root, values.packet), ids: resolve(root, values.ids), out: resolve(root, values.out) });
  }
  if (command === "report" && values["check-readme"] && takes(0, "check-readme")) return checkReadme(root);
  if (command === "report" && values.runs && takes(0, "runs", "markdown")) return runsReport(root, values.markdown ?? false);
  if (command === "report" && takes(0, "markdown")) return scoreReport(root, values.markdown ?? false);
  if (command === "ledger-code" && takes(0)) return writeLedgerCode(root);
  if (command === "regrade" && takes(1)) return regrade(root, resolve(root, rest[0]!));
  if (command === "replay" && takes(0)) return replay(root);
  const chatting = command === "chat" && takes(0, "agent", "replay");
  const tuning = command === "tune" && takes(0, "agent", "record");
  const scoring = command === "score" && takes(0, "agent", "record", "set");
  if (!chatting && !tuning && !scoring) throw new Error(USAGE);
  const set = ScoredSet.safeParse(values.set ?? "held-out");
  if (!set.success) throw new Error(`--set takes ${ScoredSet.options.join(" or ")}, not ${values.set}`);
  const name = values.agent ?? DEFAULT_AGENT;
  const agent = agents.get(name);
  if (!agent) throw new Error(`no agent named ${name}. Agents: ${[...agents.keys()].join(", ")}`);
  if (chatting) {
    const source =
      values.replay !== undefined
        ? ({ mode: "replay", case_id: values.replay } as const)
        : ({ mode: "live", lines: terminal.lines(), echo: !terminal.interactive } as const);
    return chat(root, agent, source, terminal.output);
  }
  let record: ((file: string) => Recorder) | undefined;
  if (values.record) {
    if (!agent.liveModel) throw new Error(`${agent.name} declares no live model client, so it has nothing to record`);
    const live = agent.liveModel();
    const guard = spendGuard(spendFile(root), spendCap());
    record = (file) => recordModel(live, file, guard);
  }

  if (command === "tune") return tune(root, agent, record);
  const git = gitState(root);
  const cases_sha256 = await hashCaseFiles(root, set.data);
  const code_sha256 = await hashCode(root, set.data);
  const { dir, graded } = await run(root, agent, set.data, join(root, "results"), record);
  await appendLedger(root, {
    time: new Date().toISOString(),
    agent: agent.name,
    run: shown(root, dir),
    ...git,
    cases_sha256,
    code_sha256,
    summary: { ...graded.summary, split: set.data },
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
