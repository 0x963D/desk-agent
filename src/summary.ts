import { passed, tookWrongAction } from "./grade.ts";
import { Split, type TestResult } from "./shapes.ts";

export type Summary = {
  split: Split;
  cases: number;
  passed: number;
  resolved_correctly: number;
  handed_over: number;
  wrong_action: number;
  turn_ms_p50: number;
  turn_ms_p95: number;
  cost_per_conversation_usd: number;
};

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

export function summarize(results: TestResult[]): Summary[] {
  return Split.options.flatMap((split) => {
    const inSplit = results.filter((result) => result.split === split);
    if (inSplit.length === 0) return [];
    const count = (matches: (result: TestResult) => boolean) => inSplit.filter(matches).length;
    const turnMs = inSplit.flatMap((result) => result.turn_ms).sort((a, b) => a - b);
    const cost = inSplit.reduce((sum, result) => sum + result.cost_usd, 0);
    return {
      split,
      cases: inSplit.length,
      passed: count(passed),
      resolved_correctly: count((r) => passed(r) && r.observed === "resolved"),
      handed_over: count((r) => r.observed === "handed_over"),
      wrong_action: count(tookWrongAction),
      turn_ms_p50: percentile(turnMs, 0.5),
      turn_ms_p95: percentile(turnMs, 0.95),
      cost_per_conversation_usd: cost / inSplit.length,
    };
  });
}

export function formatSummary(summary: Summary): string {
  const share = (n: number) => `${n}/${summary.cases} (${Math.round((100 * n) / summary.cases)}%)`;
  return [
    `${summary.split}: ${summary.cases} conversations`,
    `  passed every check     ${share(summary.passed)}`,
    `  resolved correctly     ${share(summary.resolved_correctly)}`,
    `  handover rate          ${share(summary.handed_over)}`,
    `  wrong-action rate      ${share(summary.wrong_action)}`,
    `  agent turn time        median ${summary.turn_ms_p50.toFixed(2)} ms, p95 ${summary.turn_ms_p95.toFixed(2)} ms`,
    `  cost per conversation  $${summary.cost_per_conversation_usd.toFixed(4)}`,
  ].join("\n");
}
