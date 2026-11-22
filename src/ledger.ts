import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { caseDir, filesIn, unlessMissing } from "./files.ts";
import { ScoredSet, type Split } from "./shapes.ts";
import { Summary } from "./summary.ts";

export const LedgerEntry = z.strictObject({
  time: z.iso.datetime(),
  agent: z.string(),
  run: z.string(),
  commit: z.string(),
  dirty: z.boolean(),
  cases_sha256: z.string(),
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

export function gitState(root: string): { commit: string; dirty: boolean } {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    throw new Error(`score records the commit it ran at, so ${root} must be a Git checkout with a commit`);
  }
}

export async function hashCaseFiles(root: string, split: Split): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await filesIn(caseDir(root, split), ".yaml")) {
    hash.update(`${relative(root, file).replaceAll("\\", "/")}\0`);
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
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
