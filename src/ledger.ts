import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { caseDir, filesIn, readJson, unlessMissing, writeJson } from "./files.ts";
import { ScoredSet, type Split } from "./shapes.ts";
import { Summary } from "./summary.ts";

export const LedgerEntry = z.strictObject({
  time: z.iso.datetime(),
  agent: z.string(),
  run: z.string(),
  commit: z.string(),
  dirty: z.boolean(),
  cases_sha256: z.string(),
  // Absent on the lines written before score recorded it. results/ledger-code.json holds theirs.
  code_sha256: z.string().optional(),
  // The summary's split is the set the run was scored on.
  summary: Summary.extend({ split: ScoredSet }),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const ledgerFile = (root: string) => join(root, "results", "ledger.jsonl");

export function scoredRunDir(root: string, run: string): string {
  const dir = resolve(root, run);
  if (relative(join(root, "results"), dir).startsWith("..")) throw new Error(`${run} is not a run under results/`);
  return dir;
}

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

export function gitState(root: string): { commit: string; dirty: boolean } {
  const text = (...args: string[]) => git(root, args).toString("utf8").trim();
  try {
    return { commit: text("rev-parse", "HEAD"), dirty: text("status", "--porcelain") !== "" };
  } catch {
    throw new Error(`score records the commit it ran at, so ${root} must be a Git checkout with a commit`);
  }
}

type HashedFile = { path: string; bytes: Buffer };

// SHA-256 over each file's path from the root, with forward slashes, and its bytes, in path order.
function digest(files: readonly HashedFile[]): string {
  const hash = createHash("sha256");
  for (const { path, bytes } of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${path}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const fromRoot = (root: string, file: string) => relative(root, file).replaceAll("\\", "/");

export async function hashCaseFiles(root: string, split: Split): Promise<string> {
  const files = await filesIn(caseDir(root, split), ".yaml");
  return digest(await Promise.all(files.map(async (file) => ({ path: fromRoot(root, file), bytes: await readFile(file) }))));
}

// What decides how a scored run plays and grades, apart from its cases: the source, the dependencies,
// the shop and the orders of the set. Tests, docs, recordings and results are left out.
const codePaths = (set: ScoredSet) => ["src", "package.json", "pnpm-lock.yaml", "fixtures/shop.yaml", `fixtures/${set}.yaml`];

// The code hash of the files on disk, so a dirty tree hashes what actually ran.
export async function hashCode(root: string, set: ScoredSet): Promise<string> {
  const files: HashedFile[] = [];
  for (const path of codePaths(set)) {
    const full = join(root, path);
    const found = await unlessMissing(stat(full), undefined);
    if (!found) continue;
    const inside = found.isDirectory()
      ? (await readdir(full, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name))
      : [full];
    for (const file of inside) files.push({ path: fromRoot(root, file), bytes: await readFile(file) });
  }
  return digest(files);
}

// The same hash of the files a commit holds, read from Git, for a ledger line that predates code_sha256.
export function hashCodeAt(root: string, commit: string, set: ScoredSet): string {
  const listed = git(root, ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...codePaths(set)]).toString("utf8");
  const paths = listed.split("\0").filter((path) => path !== "");
  return digest(paths.map((path) => ({ path, bytes: git(root, ["cat-file", "blob", `${commit}:${path}`]) })));
}

export async function readLedger(root: string): Promise<LedgerEntry[]> {
  const text = await unlessMissing(readFile(ledgerFile(root), "utf8"), "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => LedgerEntry.parse(JSON.parse(line)));
}

export async function appendLedger(root: string, entry: LedgerEntry): Promise<void> {
  const file = ledgerFile(root);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(LedgerEntry.parse(entry))}\n`);
}

const CommitId = z.string().regex(/^[0-9a-f]{40}$/i).toLowerCase();
const CommitMap = z.record(CommitId, CommitId);
type CommitMap = z.infer<typeof CommitMap>;
const commitMapPath = "results/commit-map.json";

export const readCommitMap = (root: string): Promise<CommitMap> =>
  unlessMissing(readJson(join(root, commitMapPath), CommitMap), {});

export function resolveLedgerCommit(entry: LedgerEntry, commitMap: CommitMap): string {
  return commitMap[entry.commit.toLowerCase()] ?? entry.commit;
}

// The code hash of each ledger line written before score recorded one, keyed by the line's run.
// `pnpm ledger:code` writes it from Git once, so the report needs no Git history to read it.
const LedgerCode = z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/));
export type LedgerCode = z.infer<typeof LedgerCode>;

export const ledgerCodeFile = (root: string) => join(root, "results", "ledger-code.json");

export const readLedgerCode = async (root: string): Promise<LedgerCode> =>
  unlessMissing(readJson(ledgerCodeFile(root), LedgerCode), {});

// A line's code hash: its own field, else the one in results/ledger-code.json, else unknown.
export const codeOf = (entry: LedgerEntry, code: LedgerCode): string | undefined => entry.code_sha256 ?? code[entry.run];

// Fills results/ledger-code.json for every clean line without code_sha256, and checks the hashes already
// there against Git. A dirty line is left unknown, because its commit does not hold what ran.
export async function writeLedgerCode(root: string): Promise<string> {
  gitState(root);
  const [known, commitMap] = await Promise.all([readLedgerCode(root), readCommitMap(root)]);
  const hasCommitMap = Object.keys(commitMap).length > 0;
  const code: LedgerCode = {};
  let added = 0;
  for (const entry of await readLedger(root)) {
    if (entry.code_sha256 !== undefined || entry.dirty) continue;
    const commit = resolveLedgerCommit(entry, commitMap);
    if (hasCommitMap) {
      try {
        if (git(root, ["cat-file", "-t", commit]).toString("utf8").trim() !== "commit") {
          throw new Error(`Git object ${commit} is not a commit`);
        }
      } catch (cause) {
        throw new Error(`${commitMapPath}: ledger commit ${entry.commit} resolves to ${commit}, which is not a commit in this checkout`, { cause });
      }
    }
    const hash = hashCodeAt(root, commit, entry.summary.split);
    const before = known[entry.run];
    if (before !== undefined && before !== hash) {
      throw new Error(`${fromRoot(root, ledgerCodeFile(root))} gives ${entry.run} the code hash ${before}, but its commit ${commit} hashes to ${hash}`);
    }
    if (before === undefined) added++;
    code[entry.run] = hash;
  }
  await writeJson(ledgerCodeFile(root), LedgerCode, code);
  const kept = Object.keys(code).length - added;
  return `${fromRoot(root, ledgerCodeFile(root))}: ${added} lines added, ${kept} checked against Git`;
}
