import type { LedgerEntry } from "./ledger.ts";
import { dollars, milliseconds, shareOf } from "./summary.ts";

export type ReportRow = { entry: LedgerEntry; scored: number };

type Column<Row> = { title: string; cell: (row: Row) => string; numeric: boolean };

const rate = (field: "passed" | "resolved_correctly" | "handed_over" | "wrong_action" | "blocked_attempt") =>
  ({ entry: { summary } }: ReportRow) => shareOf(summary, summary[field]);

const SCORE_COLUMNS: Column<ReportRow>[] = [
  { title: "agent", cell: ({ entry }) => entry.agent, numeric: false },
  { title: "conversations", cell: ({ entry }) => String(entry.summary.cases), numeric: true },
  { title: "passed every check", cell: rate("passed"), numeric: true },
  { title: "resolved correctly", cell: rate("resolved_correctly"), numeric: true },
  { title: "handover rate", cell: rate("handed_over"), numeric: true },
  { title: "wrong-action rate", cell: rate("wrong_action"), numeric: true },
  { title: "blocked attempts", cell: rate("blocked_attempt"), numeric: true },
  { title: "median turn", cell: ({ entry }) => milliseconds(entry.summary.turn_ms_p50), numeric: true },
  { title: "p95 turn", cell: ({ entry }) => milliseconds(entry.summary.turn_ms_p95), numeric: true },
  { title: "cost per conversation", cell: ({ entry }) => dollars(entry.summary.cost_per_conversation_usd), numeric: true },
  { title: "commit", cell: ({ entry }) => `${entry.commit.slice(0, 7)}${entry.dirty ? " (dirty)" : ""}`, numeric: false },
  { title: "times scored", cell: ({ scored }) => String(scored), numeric: true },
];

const count = (field: "cases" | "passed" | "resolved_correctly" | "handed_over" | "wrong_action" | "blocked_attempt") =>
  ({ summary }: LedgerEntry) => String(summary[field]);

const RUN_COLUMNS: Column<LedgerEntry>[] = [
  { title: "agent", cell: (entry) => entry.agent, numeric: false },
  { title: "time (UTC)", cell: (entry) => entry.time.slice(0, 19).replace("T", " "), numeric: false },
  { title: "commit", cell: (entry) => entry.commit.slice(0, 7), numeric: false },
  { title: "dirty", cell: (entry) => (entry.dirty ? "yes" : "no"), numeric: false },
  { title: "cases hash", cell: (entry) => entry.cases_sha256.slice(0, 12), numeric: false },
  { title: "conversations", cell: count("cases"), numeric: true },
  { title: "passed", cell: count("passed"), numeric: true },
  { title: "resolved correctly", cell: count("resolved_correctly"), numeric: true },
  { title: "handed over", cell: count("handed_over"), numeric: true },
  { title: "wrong actions", cell: count("wrong_action"), numeric: true },
  { title: "blocked attempts", cell: count("blocked_attempt"), numeric: true },
];

export const REPORT_NOTE =
  "Held-out set only. Each row regrades the latest scored run of one agent and matches it to its line in results/ledger.jsonl. Turn times are nearest-rank. Times scored counts the agent's lines in the ledger.";

export const RUNS_NOTE =
  "Every line of results/ledger.jsonl, oldest first, as the ledger records it. Cases hash is the start of the SHA-256 of the held-out case files the run was scored on.";

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

export const reportTable = (rows: readonly ReportRow[], { markdown }: { markdown: boolean }) =>
  layout(SCORE_COLUMNS, rows, REPORT_NOTE, markdown);

export const runsTable = (entries: readonly LedgerEntry[], { markdown }: { markdown: boolean }) =>
  layout(
    RUN_COLUMNS,
    [...entries].sort((a, b) => a.time.localeCompare(b.time)),
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
