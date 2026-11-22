import type { LedgerEntry } from "./ledger.ts";
import type { ScoredSet } from "./shapes.ts";
import { dollars, milliseconds, percentile, type Summary } from "./summary.ts";

// One agent on one set: every scored run with the same cases and the same code as its latest run.
export type ReportRow = {
  agent: string;
  // Each run's summary, regraded, which equals its ledger line.
  runs: readonly Summary[];
  // Every agent turn of those runs, sorted.
  turn_ms: readonly number[];
  cost_usd: number;
  code: string | undefined;
  commit: string;
  dirty: boolean;
  scored: number;
};

type Column<Row> = { title: string; cell: (row: Row) => string; numeric: boolean };

type Counted = "passed" | "resolved_correctly" | "handed_over" | "wrong_action" | "blocked_attempt";

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const conversations = (row: ReportRow) => sum(row.runs.map((run) => run.cases));

// The total over the row's runs, its share, and the lowest and highest count in one run.
const counted = (field: Counted) => (row: ReportRow) => {
  const per = row.runs.map((run) => run[field]);
  const total = sum(per);
  const [low, high] = [Math.min(...per), Math.max(...per)];
  const cases = conversations(row);
  return `${total}/${cases} (${Math.round((100 * total) / cases)}%), per run ${low === high ? low : `${low}–${high}`}`;
};

const shortCode = (code: string | undefined) => code?.slice(0, 12) ?? "unknown";

const SCORE_COLUMNS: Column<ReportRow>[] = [
  { title: "agent", cell: (row) => row.agent, numeric: false },
  { title: "runs", cell: (row) => String(row.runs.length), numeric: true },
  { title: "conversations", cell: (row) => String(conversations(row)), numeric: true },
  { title: "passed every check", cell: counted("passed"), numeric: true },
  { title: "resolved correctly", cell: counted("resolved_correctly"), numeric: true },
  { title: "handover rate", cell: counted("handed_over"), numeric: true },
  { title: "wrong-action rate", cell: counted("wrong_action"), numeric: true },
  { title: "blocked attempts", cell: counted("blocked_attempt"), numeric: true },
  { title: "median turn", cell: (row) => milliseconds(percentile(row.turn_ms, 0.5)), numeric: true },
  { title: "p95 turn", cell: (row) => milliseconds(percentile(row.turn_ms, 0.95)), numeric: true },
  { title: "cost per conversation", cell: (row) => dollars(row.cost_usd / conversations(row)), numeric: true },
  { title: "code", cell: (row) => shortCode(row.code), numeric: false },
  { title: "latest commit", cell: ({ commit, dirty }) => `${commit.slice(0, 7)}${dirty ? " (dirty)" : ""}`, numeric: false },
  { title: "times scored", cell: (row) => String(row.scored), numeric: true },
];

export type RunRow = { entry: LedgerEntry; code: string | undefined; commit: string };

const count = (field: "cases" | Counted) => ({ entry }: RunRow) => String(entry.summary[field]);

const RUN_COLUMNS: Column<RunRow>[] = [
  { title: "agent", cell: ({ entry }) => entry.agent, numeric: false },
  { title: "set", cell: ({ entry }) => entry.summary.split, numeric: false },
  { title: "time (UTC)", cell: ({ entry }) => entry.time.slice(0, 19).replace("T", " "), numeric: false },
  { title: "commit", cell: ({ commit }) => commit.slice(0, 7), numeric: false },
  { title: "dirty", cell: ({ entry }) => (entry.dirty ? "yes" : "no"), numeric: false },
  { title: "cases hash", cell: ({ entry }) => entry.cases_sha256.slice(0, 12), numeric: false },
  { title: "code hash", cell: ({ code }) => shortCode(code), numeric: false },
  { title: "conversations", cell: count("cases"), numeric: true },
  { title: "passed", cell: count("passed"), numeric: true },
  { title: "resolved correctly", cell: count("resolved_correctly"), numeric: true },
  { title: "handed over", cell: count("handed_over"), numeric: true },
  { title: "wrong actions", cell: count("wrong_action"), numeric: true },
  { title: "blocked attempts", cell: count("blocked_attempt"), numeric: true },
];

// The report prints the final set first, because the README quotes it, then the validation set.
export const REPORTED_SETS: readonly ScoredSet[] = ["final", "held-out"];

const SET_NAMES: Record<ScoredSet, string> = {
  final: "Final set, cases/final",
  "held-out": "Validation set, cases/held-out",
};

const reportNote = (set: ScoredSet) =>
  `${SET_NAMES[set]}. Each row covers every scored run of one agent with the same cases and the same code as its latest run, each regraded and matched to its line in results/ledger.jsonl. A count is the total over those runs, its share, and the lowest and highest count in one run. Turn times are nearest-rank over every turn of those runs. Code is the start of the SHA-256 of src/, package.json, pnpm-lock.yaml and the set's fixtures. Times scored counts the agent's lines for this set in the ledger.`;

export const RUNS_NOTE =
  "Every line of results/ledger.jsonl, oldest first, as the ledger records it. Cases hash is the start of the SHA-256 of the case files of the set the run was scored on, and code hash the same for its code.";

function layout<Row>(columns: Column<Row>[], rows: readonly Row[], note: string, markdown: boolean): string {
  const table = [columns.map((column) => column.title), ...rows.map((row) => columns.map((column) => column.cell(row)))];
  if (markdown) {
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const rule = columns.map((column) => (column.numeric ? "---:" : "---"));
    const [head = [], ...body] = table;
    return [line(head), line(rule), ...body.map(line), "", note].join("\n");
  }
  const widths = columns.map((_, at) => Math.max(...table.map((cells) => cells[at]?.length ?? 0)));
  const pad = (cells: string[]) =>
    cells
      .map((cell, at) => (columns[at]?.numeric ? cell.padStart(widths[at] ?? 0) : cell.padEnd(widths[at] ?? 0)))
      .join("  ")
      .trimEnd();
  return [...table.map(pad), "", note].join("\n");
}

export const reportTable = (set: ScoredSet, rows: readonly ReportRow[], { markdown }: { markdown: boolean }) =>
  layout(SCORE_COLUMNS, rows, reportNote(set), markdown);

export const runsTable = (rows: readonly RunRow[], { markdown }: { markdown: boolean }) =>
  layout(
    RUN_COLUMNS,
    [...rows].sort((a, b) => a.entry.time.localeCompare(b.entry.time)),
    RUNS_NOTE,
    markdown,
  );

// README.md shows the `pnpm report --markdown` table between these two lines, and
// `pnpm report --check-readme` fails when what stands between them is not the current table.
export const README_START = "<!-- report table: start -->";
export const README_END = "<!-- report table: end -->";

export function readmeTable(readme: string): string | undefined {
  const lines = readme.replaceAll("\r\n", "\n").split("\n");
  const start = lines.indexOf(README_START);
  const end = lines.indexOf(README_END);
  if (start === -1 || end <= start) return undefined;
  return lines.slice(start + 1, end).join("\n").trim();
}
