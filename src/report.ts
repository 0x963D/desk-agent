import type { LedgerEntry } from "./ledger.ts";
import { dollars, milliseconds, shareOf } from "./summary.ts";

export type ReportRow = { entry: LedgerEntry; scored: number };

type Column = { title: string; cell: (row: ReportRow) => string; numeric: boolean };

const rate = (field: "passed" | "resolved_correctly" | "handed_over" | "wrong_action" | "blocked_attempt") =>
  ({ entry: { summary } }: ReportRow) => shareOf(summary, summary[field]);

const COLUMNS: Column[] = [
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

export const REPORT_NOTE =
  "Held-out set only. Each row regrades the latest scored run of one agent and matches it to its line in results/ledger.jsonl. Turn times are nearest-rank. Times scored counts the agent's lines in the ledger.";

export function reportTable(rows: readonly ReportRow[], { markdown }: { markdown: boolean }): string {
  const table = [COLUMNS.map((column) => column.title), ...rows.map((row) => COLUMNS.map((column) => column.cell(row)))];
  if (markdown) {
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const rule = COLUMNS.map((column) => (column.numeric ? "---:" : "---"));
    const [head = [], ...body] = table;
    return [line(head), line(rule), ...body.map(line), "", REPORT_NOTE].join("\n");
  }
  const widths = COLUMNS.map((_, at) => Math.max(...table.map((cells) => cells[at]?.length ?? 0)));
  const pad = (cells: string[]) =>
    cells
      .map((cell, at) => (COLUMNS[at]?.numeric ? cell.padStart(widths[at] ?? 0) : cell.padEnd(widths[at] ?? 0)))
      .join("  ")
      .trimEnd();
  return [...table.map(pad), "", REPORT_NOTE].join("\n");
}
