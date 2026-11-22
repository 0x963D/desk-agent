import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { readJson } from "./files.ts";
import { passed } from "./grade.ts";
import { scoredRunDir } from "./ledger.ts";
import { AuditKey, Criterion, TestResult, Verdict } from "./shapes.ts";

export type Reader = { name: string; verdicts: ReadonlyMap<string, Verdict> };

export function parseVerdicts(text: string, file: string, ids: readonly string[]): Map<string, Verdict> {
  const known = new Set(ids);
  const verdicts = new Map<string, Verdict>();
  text.split("\n").forEach((line, at) => {
    if (line.trim() === "") return;
    const where = `${file} line ${at + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${where} is not JSON`);
    }
    const parsed = Verdict.safeParse(value);
    if (!parsed.success) throw new Error(`${where}\n${z.prettifyError(parsed.error)}`);
    const { id } = parsed.data;
    if (!known.has(id)) throw new Error(`${where} names ${id}, which the key does not hold`);
    if (verdicts.has(id)) throw new Error(`${where} names ${id} a second time`);
    verdicts.set(id, parsed.data);
  });
  const missing = ids.filter((id) => !verdicts.has(id));
  if (missing.length > 0) {
    throw new Error(`${file} misses ${missing.length} of ${ids.length} conversations: ${missing.join(", ")}`);
  }
  return verdicts;
}

export function kappa(a: readonly boolean[], b: readonly boolean[]): number | undefined {
  if (a.length !== b.length || a.length === 0) throw new Error("kappa needs two equal, non-empty lists");
  const n = a.length;
  const observed = a.filter((value, at) => value === b[at]).length / n;
  const yesA = a.filter(Boolean).length / n;
  const yesB = b.filter(Boolean).length / n;
  const chance = yesA * yesB + (1 - yesA) * (1 - yesB);
  return chance === 1 ? undefined : (observed - chance) / (1 - chance);
}

const share = (count: number, n: number) => `${count}/${n} (${Math.round((100 * count) / n)}%)`;

const formatKappa = (value: number | undefined) =>
  value === undefined ? "kappa undefined, because both gave one answer to every conversation" : `kappa ${value.toFixed(2)}`;

function table(rows: readonly (readonly (string | number)[])[]): string[] {
  const cells = rows.map((row) => row.map(String));
  const widths = cells[0]!.map((_, column) => Math.max(...cells.map((row) => row[column]!.length)));
  const align = (cell: string, column: number) =>
    column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!);
  return cells.map((row) => `  ${row.map(align).join("   ")}`.trimEnd());
}

export function agreementReport(
  key: AuditKey,
  automatic: ReadonlyMap<string, boolean>,
  readers: readonly Reader[],
): string {
  const ids = key.conversations.map((c) => c.id);
  const agents = [...new Set(key.conversations.map((c) => c.agent))].sort();
  const ofAgent = (agent: string) => key.conversations.filter((c) => c.agent === agent).map((c) => c.id);
  const grader = ids.map((id) => automatic.get(id)!);
  const sections: string[] = [];

  for (const reader of readers) {
    const verdict = (id: string) => reader.verdicts.get(id)!;
    const acceptable = ids.map((id) => verdict(id).acceptable);
    const count = (list: readonly string[], test: (v: Verdict) => boolean) => list.filter((id) => test(verdict(id))).length;
    const cell = (mine: boolean, theirs: boolean) =>
      acceptable.filter((value, at) => value === mine && grader[at] === theirs).length;
    const agreed = acceptable.filter((value, at) => value === grader[at]).length;
    const failing = Criterion.options
      .map((name) => ({ name, all: count(ids, (v) => !v[name]) }))
      .filter(({ all }) => all > 0)
      .sort((a, b) => b.all - a.all);
    sections.push(
      [
        `reader ${reader.name}`,
        ...table([
          ["agent", "acceptable", "automatic pass"],
          ...agents.map((agent) => {
            const list = ofAgent(agent);
            return [agent, `${count(list, (v) => v.acceptable)}/${list.length}`, `${list.filter((id) => automatic.get(id)).length}/${list.length}`];
          }),
        ]),
        `  agrees with the automatic grader on ${share(agreed, ids.length)}, ${formatKappa(kappa(acceptable, grader))}`,
        ...table([
          ["", "automatic pass", "automatic fail"],
          ["reader acceptable", cell(true, true), cell(true, false)],
          ["reader not acceptable", cell(false, true), cell(false, false)],
        ]),
        ...(failing.length === 0
          ? ["  no criterion failed"]
          : table([
              ["failed criterion", "all", ...agents],
              ...failing.map(({ name, all }) => [name, all, ...agents.map((agent) => count(ofAgent(agent), (v) => !v[name]))]),
            ])),
      ].join("\n"),
    );
  }

  readers.forEach((first, at) => {
    for (const second of readers.slice(at + 1)) {
      const a = ids.map((id) => first.verdicts.get(id)!.acceptable);
      const b = ids.map((id) => second.verdicts.get(id)!.acceptable);
      const differ = ids.filter((_, index) => a[index] !== b[index]);
      sections.push(
        [
          `readers ${first.name} and ${second.name}`,
          `  agree on acceptable for ${share(ids.length - differ.length, ids.length)}, ${formatKappa(kappa(a, b))}`,
          `  disagree on ${differ.length}${differ.length > 0 ? `: ${differ.join(", ")}` : ""}`,
        ].join("\n"),
      );
    }
  });
  return sections.join("\n\n");
}

async function automaticGrades(root: string, key: AuditKey): Promise<Map<string, boolean>> {
  const runs = new Map<string, TestResult[]>();
  const grades = new Map<string, boolean>();
  for (const { id, run, case_id } of key.conversations) {
    let results = runs.get(run);
    if (!results) {
      results = await readJson(join(scoredRunDir(root, run), "results.json"), TestResult.array());
      runs.set(run, results);
    }
    const result = results.find((r) => r.case_id === case_id);
    if (!result) throw new Error(`${run}/results.json holds no result for ${case_id}`);
    grades.set(id, passed(result));
  }
  return grades;
}

export async function auditAgreement(root: string, keyFile: string, verdictFiles: readonly string[]): Promise<string> {
  const key = await readJson(keyFile, AuditKey);
  const ids = key.conversations.map((c) => c.id);
  const readers = await Promise.all(
    verdictFiles.map(async (file) => ({
      name: basename(file, ".jsonl"),
      verdicts: parseVerdicts(await readFile(file, "utf8"), file, ids),
    })),
  );
  const names = readers.map((reader) => reader.name);
  const repeated = names.find((name, at) => names.indexOf(name) !== at);
  if (repeated) throw new Error(`two verdict files are named ${repeated}. The file name names the reader`);
  return agreementReport(key, await automaticGrades(root, key), readers);
}
