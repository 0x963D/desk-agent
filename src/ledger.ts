import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { caseDir, filesIn } from "./files.ts";
import type { Split } from "./shapes.ts";
import { Summary } from "./summary.ts";

export const LedgerEntry = z.strictObject({
  time: z.iso.datetime(),
  agent: z.string(),
  run: z.string(),
  commit: z.string(),
  dirty: z.boolean(),
  cases_sha256: z.string(),
  summary: Summary,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const ledgerFile = (root: string) => join(root, "results", "ledger.jsonl");

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

export async function appendLedger(root: string, entry: LedgerEntry): Promise<void> {
  const file = ledgerFile(root);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(LedgerEntry.parse(entry))}\n`);
}
