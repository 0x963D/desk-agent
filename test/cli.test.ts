import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../src/cli.ts";
import { readJson } from "../src/files.ts";
import { hashCaseFiles, hashCodeAt, LedgerEntry } from "../src/ledger.ts";
import { TestResult } from "../src/shapes.ts";
import { commitAll, tempDir, testRepo } from "./helpers.ts";

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

// A final set for the test repository: the held-out cases and orders moved to the final split and its order numbers.
async function addFinalSet(root: string) {
  const final = (text: string) => text.replace("split: held-out", "split: final").replaceAll("SC-30", "SC-50").replaceAll("SC30", "SC50");
  await mkdir(join(root, "cases", "final"));
  for (const name of await readdir(join(root, "cases", "held-out"))) {
    await writeFile(join(root, "cases", "final", name), final(await readFile(join(root, "cases", "held-out", name), "utf8")));
  }
  await writeFile(join(root, "fixtures", "final.yaml"), final(await readFile(join(root, "fixtures", "held-out.yaml"), "utf8")));
}

test("score --set final runs the final cases and its ledger line records the set and the hash of its cases", async () => {
  const root = await testRepo();
  await addFinalSet(root);
  commitAll(root);

  const printed = await main(["score", "--set", "final"], root);
  await main(["score"], root);

  expect(printed).toContain("final: 2 conversations");
  expect(printed).toContain("passed every check     2/2 (100%)");
  const [final, heldOut] = await ledger(root);
  expect(final?.summary.split).toBe("final");
  expect(final?.cases_sha256).toBe(await hashCaseFiles(root, "final"));
  expect(heldOut?.summary.split).toBe("held-out");
  expect(heldOut?.cases_sha256).toBe(await hashCaseFiles(root, "held-out"));
  expect(heldOut?.cases_sha256).not.toBe(final?.cases_sha256);
});

test("report shows each scored set in its own table, the final set first", async () => {
  const root = await testRepo();
  await addFinalSet(root);
  commitAll(root);
  await main(["score"], root);
  await main(["score", "--set", "final"], root);

  const lines = (await main(["report", "--markdown"], root)).split("\n");

  const notes = lines.filter((line) => /^(Final|Validation) set/.test(line)).map((line) => line.split(".")[0]);
  expect(notes).toEqual(["Final set, cases/final", "Validation set, cases/held-out"]);
  expect(lines.filter((line) => line.startsWith("| rule-based |"))).toHaveLength(2);
  const heads = lines.flatMap((line, at) => (line.startsWith("| agent |") ? [at] : []));
  const finalNote = lines.findIndex((line) => line.startsWith("Final set"));
  expect(heads).toHaveLength(2);
  expect(heads[0]).toBeLessThan(finalNote);
  expect(finalNote).toBeLessThan(heads[1]!);
});

test("the tuning command reaches neither scored set, and score takes only a scored set", async () => {
  const root = await testRepo();
  await addFinalSet(root);
  commitAll(root);

  for (const set of ["final", "held-out"]) await expect(main(["tune", "--set", set], root)).rejects.toThrow("usage:");
  await expect(main(["score", "--set", "tuning"], root)).rejects.toThrow("--set takes held-out or final, not tuning");
  await expect(readdir(join(root, "results"))).rejects.toThrow();
});

test("a final order outside SC-5000 to SC-5999 fails the load", async () => {
  const root = await testRepo();
  await addFinalSet(root);
  const file = join(root, "fixtures", "final.yaml");
  await writeFile(file, (await readFile(file, "utf8")).replace("SC-5001", "SC-3001"));
  commitAll(root);

  await expect(main(["score", "--set", "final"], root)).rejects.toThrow("SC-3001 is outside the final range SC-5000 to SC-5999");
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
  "| agent | runs | conversations | passed every check | resolved correctly | handover rate | wrong-action rate | blocked attempts | median turn | p95 turn | cost per conversation | code | latest commit | times scored |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |",
];

const tree = async (root: string) => {
  const files = (await readdir(root, { recursive: true })).filter((file) => !file.startsWith(".git")).sort();
  return Promise.all(files.map(async (file) => [file, await readFile(join(root, file)).catch(() => "dir")] as const));
};

const reportRows = async (root: string) =>
  (await main(["report", "--markdown"], root))
    .split("\n")
    .filter((line) => line.startsWith("| rule-based |"))
    .map((line) => line.slice(2, -2).split(" | "));

test("report prints one row per agent, here over its one scored run, and writes nothing", async () => {
  const { root, commit } = await scoredRepo();
  const [entry] = await ledger(root);
  const turns = [entry?.summary.turn_ms_p50, entry?.summary.turn_ms_p95].map((ms) => `${ms?.toFixed(2)} ms`);
  const shares = ["2/2 (100%), per run 2", "2/2 (100%), per run 2", "0/2 (0%), per run 0", "0/2 (0%), per run 0", "0/2 (0%), per run 0"];
  const row = ["rule-based", "1", "2", ...shares, ...turns, "$0.0000", entry!.code_sha256!.slice(0, 12), commit, "1"];
  const before = await tree(root);

  const markdown = await main(["report", "--markdown"], root);
  const plain = await main(["report"], root);

  expect(markdown.split("\n").slice(0, 3)).toEqual([...MARKDOWN_HEAD, `| ${row.join(" | ")} |`]);
  const [plainHead, plainRow] = plain.split("\n");
  expect(plainHead?.split(/ {2,}/)).toEqual(MARKDOWN_HEAD[0]?.slice(2, -2).split(" | "));
  expect(plainRow?.split(/ {2,}/)).toEqual(row);
  expect(plain).toContain("Validation set, cases/held-out.");
  expect(await tree(root)).toEqual(before);
});

test("a row covers every run of the agent with the same cases and code, as a total and the range per run", async () => {
  const { root, commit } = await scoredRepo();
  await main(["score"], root);
  const [first, second] = await ledger(root);

  const [row] = await reportRows(root);

  expect(second?.dirty).toBe(true);
  expect(second?.code_sha256).toBe(first?.code_sha256);
  expect(row?.slice(0, 5)).toEqual(["rule-based", "2", "4", "4/4 (100%), per run 2", "4/4 (100%), per run 2"]);
  expect(row?.slice(-2)).toEqual([`${commit} (dirty)`, "2"]);
  // The earlier run is regraded too, so a ledger line that no longer agrees with it stops the report.
  const changed = { ...first, summary: { ...first!.summary, passed: 1 } };
  await writeFile(join(root, "results", "ledger.jsonl"), `${JSON.stringify(changed)}\n${JSON.stringify(second)}\n`);
  await expect(main(["report"], root)).rejects.toThrow(/passed grades to 2 but the ledger records 1/);
});

test("a run with other code or other cases is not in the row, and still counts as a time scored", async () => {
  const { root } = await scoredRepo();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "note.ts"), "// A change to the code.\n");
  await main(["score"], root);
  const [atFirst, withNote] = await ledger(root);
  const caseFile = join(root, "cases", "held-out", "ro-unde-e-comanda.yaml");
  await writeFile(caseFile, `${await readFile(caseFile, "utf8")}# edited\n`);
  await main(["score"], root);
  const [, , withEdit] = await ledger(root);

  expect(withNote?.code_sha256).not.toBe(atFirst?.code_sha256);
  expect(withEdit?.code_sha256).toBe(withNote?.code_sha256);
  expect(withEdit?.cases_sha256).not.toBe(withNote?.cases_sha256);
  const [row] = await reportRows(root);
  expect(row?.slice(0, 3)).toEqual(["rule-based", "1", "2"]);
  expect(row?.at(-1)).toBe("3");
});

test("a line without a code hash stands alone until pnpm ledger:code gives it one from Git", async () => {
  const { root } = await scoredRepo();
  commitAll(root);
  await main(["score"], root);
  const lines = await ledger(root);
  for (const entry of lines) expect(entry.code_sha256).toBe(hashCodeAt(root, entry.commit, "held-out"));
  const ledgerFile = join(root, "results", "ledger.jsonl");
  await writeFile(ledgerFile, lines.map(({ code_sha256, ...old }) => `${JSON.stringify(old)}\n`).join(""));

  const [alone] = await reportRows(root);
  const written = await main(["ledger-code"], root);
  const [together] = await reportRows(root);
  const checked = await main(["ledger-code"], root);

  expect(alone?.slice(1, 3)).toEqual(["1", "2"]);
  expect(alone?.at(-3)).toBe("unknown");
  expect(written).toBe("results/ledger-code.json: 2 lines added, 0 checked against Git");
  expect(together?.slice(1, 3)).toEqual(["2", "4"]);
  expect(together?.at(-3)).toBe(lines[0]!.code_sha256!.slice(0, 12));
  expect(checked).toBe("results/ledger-code.json: 0 lines added, 2 checked against Git");
  const codeFile = join(root, "results", "ledger-code.json");
  await writeFile(codeFile, (await readFile(codeFile, "utf8")).replace(lines[0]!.code_sha256!, "0".repeat(64)));
  await expect(main(["ledger-code"], root)).rejects.toThrow(/gives .* the code hash 0{64}, but its commit/);
});

async function repoWithOldLedger() {
  const { root } = await scoredRepo();
  const [entry] = await ledger(root);
  const { code_sha256, ...old } = entry!;
  const line = `${JSON.stringify(old)}\n`;
  await writeFile(join(root, "results", "ledger.jsonl"), line);
  return { root, original: old.commit, line };
}

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

test("ledger:code and both report tables resolve a ledger commit after a history rewrite", async () => {
  const { root, original, line } = await repoWithOldLedger();
  await main(["ledger-code"], root);
  const hashes = await readFile(join(root, "results", "ledger-code.json"), "utf8");
  git(root, "-c", "user.name=Test", "-c", "user.email=public@example.com", "commit", "--amend", "--reset-author", "-qm", "rewritten cases");
  const rewritten = git(root, "rev-parse", "HEAD");
  expect(rewritten).not.toBe(original);
  await writeFile(join(root, "results", "commit-map.json"), JSON.stringify({ [original]: rewritten }));
  commitAll(root);
  const clone = await tempDir();
  git(root, "clone", "--no-local", "--quiet", "-c", "core.autocrlf=false", root, clone);
  expect(() => git(clone, "cat-file", "-e", original)).toThrow();

  await expect(main(["ledger-code"], clone)).resolves.toBe("results/ledger-code.json: 0 lines added, 1 checked against Git");
  const [row] = await reportRows(clone);
  expect(row?.at(-2)).toBe(rewritten.slice(0, 7));
  const runs = await main(["report", "--runs", "--markdown"], clone);
  expect(runs.split("\n")[2]?.split(" | ")[3]).toBe(rewritten.slice(0, 7));
  expect(await readFile(join(clone, "results", "ledger.jsonl"), "utf8")).toBe(line);
  expect(await readFile(join(clone, "results", "ledger-code.json"), "utf8")).toBe(hashes);
});

test.each(["missing object", "tree"] as const)("ledger:code names both IDs when a commit map points to a %s", async (kind) => {
  const { root, original } = await repoWithOldLedger();
  const target = kind === "tree" ? git(root, "rev-parse", "HEAD^{tree}") : "0".repeat(40);
  await writeFile(join(root, "results", "commit-map.json"), JSON.stringify({ [original]: target }));

  await expect(main(["ledger-code"], root)).rejects.toThrow(
    `results/commit-map.json: ledger commit ${original} resolves to ${target}, which is not a commit in this checkout`,
  );
});

test.each(["key", "value"] as const)("report rejects a commit map with an invalid %s", async (field) => {
  const { root, original } = await repoWithOldLedger();
  const [key, value] = field === "key" ? ["short", original] : [original, "short"];
  const file = join(root, "results", "commit-map.json");
  await writeFile(file, JSON.stringify({ [key]: value }));

  await expect(main(["report", "--runs"], root)).rejects.toThrow(file);
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
  await writeFile(caseFile, (await readFile(caseFile, "utf8")).replace("track/SC3002", "track/SC9999"));

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
    "held-out",
    entry.time.slice(0, 19).replace("T", " "),
    commit,
    dirty,
    entry.cases_sha256.slice(0, 12),
    entry.code_sha256!.slice(0, 12),
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
    "set",
    "time (UTC)",
    "commit",
    "dirty",
    "cases hash",
    "code hash",
    "conversations",
    "passed",
    "resolved correctly",
    "handed over",
    "wrong actions",
    "blocked attempts",
  ]);
  expect(rest.slice(0, 2).map((line) => line.split(/ {2,}/))).toEqual([row(lines[0]!, "no"), row(lines[1]!, "yes")]);
  expect(markdown.split("\n").slice(1, 4)).toEqual([
    "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
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
  await writeFile(join(root, "README.md"), readme(table.replace("| 2/2 (100%), per run 2 |", "| 2/2 (99%), per run 2 |")));

  await expect(main(["report", "--check-readme"], root)).rejects.toThrow(
    "Line 3 of the table reads \"| rule-based | 1 | 2 | 2/2 (99%), per run 2 |",
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

test("replay runs the rule-based agent and skips model agents without a recordings directory", async () => {
  const root = await testRepo();

  const printed = await main(["replay"], root);

  expect(printed).toContain("agent: rule-based");
  expect(printed).toContain("tuning: 4 conversations");
  for (const name of [
    "plain-gpt-6-luna",
    "plain-gpt-6.2-sol",
    "sdk-gpt-6-luna",
    "sdk-gpt-6.2-sol",
    "sdk-claude-haiku-5-5",
    "sdk-claude-sonnet-5-5",
  ]) {
    expect(printed).toContain(`agent: ${name}\nskipped: recordings/${name} is missing`);
  }
  expect(await readdir(join(root, "traces"))).toEqual(["rule-based"]);
});

test("replay fails when a model agent's recordings directory is present but a tuning recording is missing", async () => {
  const root = await testRepo();
  await mkdir(join(root, "recordings", "plain-gpt-6-luna", "tuning"), { recursive: true });

  await expect(main(["replay"], root)).rejects.toThrow("recordings/plain-gpt-6-luna/tuning/en-asks-for-a-person.json");
});

test("replay refuses a recordings directory without a registered model agent", async () => {
  const root = await testRepo();
  await mkdir(join(root, "recordings", "misspelt-agent"), { recursive: true });

  await expect(main(["replay"], root)).rejects.toThrow("recordings/misspelt-agent has no registered model agent");
});
