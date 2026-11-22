import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../src/cli.ts";
import { readJson } from "../src/files.ts";
import { LedgerEntry } from "../src/ledger.ts";
import { TestResult } from "../src/shapes.ts";
import { testRepo } from "./helpers.ts";

const runDirs = (root: string, base: string) => readdir(join(root, base, "rule-based"));

async function onlyRun(root: string, base: string): Promise<string> {
  const [dir, ...more] = await runDirs(root, base);
  if (!dir || more.length > 0) throw new Error(`expected one run under ${base}`);
  return join(root, base, "rule-based", dir);
}

const results = (dir: string) => readJson(join(dir, "results.json"), TestResult.array());

function commitAll(root: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: root });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "cases");
  return git("rev-parse", "HEAD").toString().trim();
}

async function ledger(root: string): Promise<LedgerEntry[]> {
  const text = await readFile(join(root, "results", "ledger.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => LedgerEntry.parse(JSON.parse(line)));
}

test("tune runs the tuning cases through the rule-based agent and saves the run under traces", async () => {
  const root = await testRepo();

  const printed = await main(["tune"], root);

  const dir = await onlyRun(root, "traces");
  expect(printed).toContain("tuning: 4 conversations");
  expect(printed).toContain("passed every check     4/4 (100%)");
  expect(printed).toContain("blocked attempts       1/4 (25%)");
  expect(printed).toContain("(blocked: return for SC-1005: window_closed)");
  expect(printed).not.toContain("held-out");
  expect((await results(dir)).map((r) => [r.case_id, r.observed])).toEqual([
    ["en-asks-for-a-person", "handed_over"],
    ["en-where-is-my-order", "resolved"],
    ["ro-retur-expirat", "refused"],
    ["ro-retur-in-termen", "resolved"],
  ]);
  expect((await readdir(join(dir, "conversations"))).sort()).toEqual([
    "en-asks-for-a-person.json",
    "en-where-is-my-order.json",
    "ro-retur-expirat.json",
    "ro-retur-in-termen.json",
  ]);
});

test("each run writes its own directory and leaves earlier runs as they were", async () => {
  const root = await testRepo();
  await main(["tune"], root);
  const first = await onlyRun(root, "traces");
  const saved = await readFile(join(first, "results.json"), "utf8");

  await main(["tune"], root);

  expect(await runDirs(root, "traces")).toHaveLength(2);
  expect(await readFile(join(first, "results.json"), "utf8")).toBe(saved);
});

test("score runs the held-out cases, saves them under results and records the run in the ledger", async () => {
  const root = await testRepo();
  const commit = commitAll(root);

  const printed = await main(["score"], root);

  const dir = await onlyRun(root, "results");
  expect(printed).toContain("held-out: 2 conversations");
  expect((await readdir(dir)).sort()).toEqual(["conversations", "results.json", "summary.json"]);
  const [entry] = await ledger(root);
  expect(entry).toMatchObject({
    agent: "rule-based",
    commit,
    dirty: false,
    run: dir.slice(root.length + 1).replaceAll("\\", "/"),
    summary: { split: "held-out", cases: 2, passed: 2, wrong_action: 0, blocked_attempt: 0 },
  });
  expect(entry?.cases_sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the ledger gains one line per score and notes a dirty tree and changed cases", async () => {
  const root = await testRepo();
  commitAll(root);
  await main(["score"], root);
  const caseFile = join(root, "cases", "held-out", "ro-unde-e-comanda.yaml");
  await writeFile(caseFile, `${await readFile(caseFile, "utf8")}# edited\n`);

  await main(["score"], root);

  const [first, second] = await ledger(root);
  expect(second?.dirty).toBe(true);
  expect(second?.cases_sha256).not.toBe(first?.cases_sha256);
});

test("score outside a Git checkout refuses before it runs", async () => {
  const root = await testRepo();

  await expect(main(["score"], root)).rejects.toThrow("Git checkout");
  await expect(readdir(join(root, "results"))).rejects.toThrow();
});

test("--agent picks an agent from the registry and rejects a name it does not hold", async () => {
  const root = await testRepo();

  expect(await main(["tune", "--agent", "rule-based"], root)).toContain("agent: rule-based");
  await expect(main(["tune", "--agent", "gpt"], root)).rejects.toThrow("no agent named gpt. Agents: rule-based");
});

test.each([[["tune", "held-out"]], [["tune", "--split=held-out"]], [["score", "tuning"]], [["regrade"]], [[]]])(
  "%j is refused with the usage line",
  async (args) => {
    await expect(main(args, await testRepo())).rejects.toThrow("usage:");
  },
);

test("a command on an empty set exits with a clear message", async () => {
  const root = await testRepo();
  await rm(join(root, "cases", "tuning"), { recursive: true });

  await expect(main(["tune"], root)).rejects.toThrow(
    "no tuning cases: cases/tuning holds no case files. Write them as docs/writing-cases.md describes.",
  );
});

test("regrading a saved run reproduces its report without running the agent", async () => {
  const root = await testRepo();
  const printed = await main(["tune"], root);
  const dir = await onlyRun(root, "traces");

  expect(await main(["regrade", dir], root)).toBe(printed);
});

test("regrading applies the case as it reads now", async () => {
  const root = await testRepo();
  await main(["tune"], root);
  const caseFile = join(root, "cases", "tuning", "en-where-is-my-order.yaml");
  await writeFile(caseFile, (await readFile(caseFile, "utf8")).replace("track/SC1003", "track/SC9999"));

  const reprinted = await main(["regrade", await onlyRun(root, "traces")], root);

  expect(reprinted).toContain("FAIL  missing_mention: https://curier.example/track/SC9999");
  expect(reprinted).toContain("passed every check     3/4 (75%)");
});

test("an interrupted run cannot be regraded into numbers", async () => {
  const root = await testRepo();
  await main(["tune"], root);
  const dir = await onlyRun(root, "traces");
  await rm(join(dir, "conversations", "ro-retur-expirat.json"));

  await expect(main(["regrade", dir], root)).rejects.toThrow(
    "the run covers 3 of 4 tuning cases (missing: ro-retur-expirat)",
  );
});
