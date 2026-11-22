import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../src/cli.ts";
import { readJson } from "../src/files.ts";
import { LedgerEntry } from "../src/ledger.ts";
import { TestResult } from "../src/shapes.ts";
import { commitAll, testRepo } from "./helpers.ts";

const runDirs = (root: string, base: string) => readdir(join(root, base, "rule-based"));

async function onlyRun(root: string, base: string): Promise<string> {
  const [dir, ...more] = await runDirs(root, base);
  if (!dir || more.length > 0) throw new Error(`expected one run under ${base}`);
  return join(root, base, "rule-based", dir);
}

const results = (dir: string) => readJson(join(dir, "results.json"), TestResult.array());

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

test("a score whose ledger line cannot be written saves no results and no summary", async () => {
  const root = await testRepo();
  commitAll(root);
  const ledgerPath = join(root, "results", "ledger.jsonl");
  await mkdir(ledgerPath, { recursive: true });

  await expect(main(["score"], root)).rejects.toThrow();

  const dir = await onlyRun(root, "results");
  expect(await readdir(dir)).toEqual(["conversations"]);
  await rm(ledgerPath, { recursive: true });
  expect(await main(["regrade", dir], root)).toContain("No line in results/ledger.jsonl records this run");
});

test("regrading a scored run says so when the held-out cases have changed since its ledger line", async () => {
  const root = await testRepo();
  commitAll(root);
  const printed = await main(["score"], root);
  const dir = await onlyRun(root, "results");
  expect(await main(["regrade", dir], root)).toBe(printed);
  const caseFile = join(root, "cases", "held-out", "ro-unde-e-comanda.yaml");
  await writeFile(caseFile, `${await readFile(caseFile, "utf8")}# edited\n`);

  const reprinted = await main(["regrade", dir], root);

  expect(reprinted).toContain("The held-out cases have changed since this run was scored");
  expect(reprinted.startsWith(printed)).toBe(true);
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

test.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
  "--agent %s is refused before a run directory is created",
  async (name) => {
    const root = await testRepo();

    await expect(main(["tune", "--agent", name], root)).rejects.toThrow(`no agent named ${name}. Agents: rule-based`);
    await expect(readdir(join(root, "traces"))).rejects.toThrow();
  },
);

test("--record refuses an agent that declares no live model client, before it runs", async () => {
  const root = await testRepo();

  await expect(main(["tune", "--record"], root)).rejects.toThrow(
    "rule-based declares no live model client, so it has nothing to record",
  );
  await expect(readdir(join(root, "traces"))).rejects.toThrow();
});

test.each([
  [["tune", "held-out"]],
  [["tune", "--split=held-out"]],
  [["score", "tuning"]],
  [["regrade"]],
  [["regrade", "traces/rule-based/run", "--record"]],
  [["report", "--agent", "rule-based"]],
  [["report", "results"]],
  [["tune", "--markdown"]],
  [["replay", "--record"]],
  [["report", "--runs", "--agent", "rule-based"]],
  [["report", "--check-readme", "--markdown"]],
  [["report", "--runs", "--check-readme"]],
  [["tune", "--replay", "en-where-is-my-order"]],
  [[]],
])(
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

const scoredRepo = async () => {
  const root = await testRepo();
  const commit = commitAll(root);
  await main(["score"], root);
  return { root, commit: commit.slice(0, 7) };
};

const MARKDOWN_HEAD = [
  "| agent | conversations | passed every check | resolved correctly | handover rate | wrong-action rate | blocked attempts | median turn | p95 turn | cost per conversation | commit | times scored |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
];

const tree = async (root: string) => {
  const files = (await readdir(root, { recursive: true })).filter((file) => !file.startsWith(".git")).sort();
  return Promise.all(files.map(async (file) => [file, await readFile(join(root, file)).catch(() => "dir")] as const));
};

test("report prints one row per agent from its latest scored run, and writes nothing", async () => {
  const { root, commit } = await scoredRepo();
  const [entry] = await ledger(root);
  const turns = [entry?.summary.turn_ms_p50, entry?.summary.turn_ms_p95].map((ms) => `${ms?.toFixed(2)} ms`);
  const cells = ["rule-based", "2", "2/2 (100%)", "2/2 (100%)", "0/2 (0%)", "0/2 (0%)", "0/2 (0%)", ...turns];
  const row = [...cells, "$0.0000", commit, "1"];
  const before = await tree(root);

  const markdown = await main(["report", "--markdown"], root);
  const plain = await main(["report"], root);

  expect(markdown.split("\n").slice(0, 3)).toEqual([...MARKDOWN_HEAD, `| ${row.join(" | ")} |`]);
  const [plainHead, plainRow] = plain.split("\n");
  expect(plainHead?.split(/ {2,}/)).toEqual(MARKDOWN_HEAD[0]?.slice(2, -2).split(" | "));
  expect(plainRow?.split(/ {2,}/)).toEqual(row);
  expect(plain).toContain("Held-out set only.");
  expect(await tree(root)).toEqual(before);
});

test("report counts every score of an agent and shows the latest one", async () => {
  const { root, commit } = await scoredRepo();
  await main(["score"], root);

  const markdown = await main(["report", "--markdown"], root);

  const rows = markdown.split("\n").filter((line) => line.startsWith("| rule-based |"));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.endsWith(`| ${commit} (dirty) | 2 |`)).toBe(true);
});

test("report stops when a regraded run disagrees with its ledger line", async () => {
  const { root } = await scoredRepo();
  const file = join(root, "results", "ledger.jsonl");
  const [entry] = await ledger(root);
  await writeFile(file, `${JSON.stringify({ ...entry, summary: { ...entry?.summary, passed: 1 } })}\n`);

  await expect(main(["report"], root)).rejects.toThrow(
    /no longer agrees with its line in results\/ledger\.jsonl of .*: passed grades to 2 but the ledger records 1\. The held-out cases are the ones it was scored on/,
  );
});

test("report says the cases changed when that is why a regraded run disagrees", async () => {
  const { root } = await scoredRepo();
  const caseFile = join(root, "cases", "held-out", "ro-unde-e-comanda.yaml");
  await writeFile(caseFile, (await readFile(caseFile, "utf8")).replace("track/SC2002", "track/SC9999"));

  await expect(main(["report"], root)).rejects.toThrow(
    "passed grades to 1 but the ledger records 2; resolved_correctly grades to 1 but the ledger records 2. The held-out cases have changed since it was scored",
  );
});

test("report on an empty ledger exits with a clear message", async () => {
  await expect(main(["report"], await testRepo())).rejects.toThrow(
    "no scoring run: results/ledger.jsonl holds no line. pnpm score records one.",
  );
});

test("report --runs prints every ledger line, oldest first, from the ledger alone", async () => {
  const { root, commit } = await scoredRepo();
  await main(["score"], root);
  const lines = await ledger(root);
  await rm(join(root, "results", "rule-based"), { recursive: true });

  const plain = await main(["report", "--runs"], root);
  const markdown = await main(["report", "--runs", "--markdown"], root);

  const row = (entry: LedgerEntry, dirty: string) => [
    "rule-based",
    entry.time.slice(0, 19).replace("T", " "),
    commit,
    dirty,
    entry.cases_sha256.slice(0, 12),
    "2",
    "2",
    "2",
    "0",
    "0",
    "0",
  ];
  const [head, ...rest] = plain.split("\n");
  expect(head?.split(/ {2,}/)).toEqual([
    "agent",
    "time (UTC)",
    "commit",
    "dirty",
    "cases hash",
    "conversations",
    "passed",
    "resolved correctly",
    "handed over",
    "wrong actions",
    "blocked attempts",
  ]);
  expect(rest.slice(0, 2).map((line) => line.split(/ {2,}/))).toEqual([row(lines[0]!, "no"), row(lines[1]!, "yes")]);
  expect(markdown.split("\n").slice(1, 4)).toEqual([
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${row(lines[0]!, "no").join(" | ")} |`,
    `| ${row(lines[1]!, "yes").join(" | ")} |`,
  ]);
  await expect(main(["report"], root)).rejects.toThrow("holds no saved conversations");
});

const readme = (table: string) => `# Shop agent

## Results

<!-- report table: start -->
${table}
<!-- report table: end -->

More prose.
`;

test("report --check-readme passes while the README shows the current report table", async () => {
  const { root } = await scoredRepo();
  await writeFile(join(root, "README.md"), readme(await main(["report", "--markdown"], root)));

  await expect(main(["report", "--check-readme"], root)).resolves.toBe(
    "README.md shows the current pnpm report --markdown table.",
  );
});

test("report --check-readme fails when a number in the README differs from the report", async () => {
  const { root } = await scoredRepo();
  const table = await main(["report", "--markdown"], root);
  await writeFile(join(root, "README.md"), readme(table.replace("| 2/2 (100%) |", "| 2/2 (99%) |")));

  await expect(main(["report", "--check-readme"], root)).rejects.toThrow(
    "Line 3 of the table reads \"| rule-based | 2 | 2/2 (99%) |",
  );
});

test("report --check-readme fails once a new score makes the README table stale", async () => {
  const { root } = await scoredRepo();
  await writeFile(join(root, "README.md"), readme(await main(["report", "--markdown"], root)));

  await main(["score"], root);

  await expect(main(["report", "--check-readme"], root)).rejects.toThrow("is not the current pnpm report --markdown");
});

test("report --check-readme fails when the README has no marked table", async () => {
  const { root } = await scoredRepo();
  await writeFile(join(root, "README.md"), "# Shop agent\n\n| agent |\n");

  await expect(main(["report", "--check-readme"], root)).rejects.toThrow(
    "README.md holds no report table between the lines <!-- report table: start --> and <!-- report table: end -->",
  );
});

test("replay runs the tuning set for every agent that can run offline and skips one without recordings", async () => {
  const root = await testRepo();

  const printed = await main(["replay"], root);

  expect(printed).toContain("agent: rule-based");
  expect(printed).toContain("tuning: 4 conversations");
  for (const name of ["plain-gpt-6-luna", "plain-gpt-6.2-sol"]) {
    expect(printed).toContain(`agent: ${name}\nskipped: recordings/${name}/tuning holds no recordings`);
  }
  expect(await readdir(join(root, "traces"))).toEqual(["rule-based"]);
});
