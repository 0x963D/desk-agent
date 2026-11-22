import { z } from "zod";
import { passed, tookWrongAction } from "./grade.ts";
import { Split, type TestCase, type TestResult } from "./shapes.ts";

export const Summary = z.strictObject({
  split: Split,
  agent: z.string(),
  cases: z.number().int(),
  passed: z.number().int(),
  resolved_correctly: z.number().int(),
  handed_over: z.number().int(),
  wrong_action: z.number().int(),
  blocked_attempt: z.number().int(),
  turn_ms_p50: z.number(),
  turn_ms_p95: z.number(),
  cost_per_conversation_usd: z.number(),
});
export type Summary = z.infer<typeof Summary>;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function refuseIncomplete(split: Split, cases: readonly TestCase[], results: readonly TestResult[]) {
  const ids = new Set(cases.map((c) => c.id));
  const ran = results.map((result) => result.case_id);
  const problems = [
    ["missing", cases.map((c) => c.id).filter((id) => !ran.includes(id))],
    [`not ${split} cases`, ran.filter((id) => !ids.has(id))],
    ["graded twice", ran.filter((id, at) => ran.indexOf(id) !== at)],
  ] as const;
  const found = problems.filter(([, list]) => list.length > 0);
  if (found.length === 0) return;
  const covered = new Set(ran.filter((id) => ids.has(id))).size;
  throw new Error(
    `the run covers ${covered} of ${cases.length} ${split} cases (${found
      .map(([label, list]) => `${label}: ${list.join(", ")}`)
      .join("; ")}). A summary needs one result for every case of its split.`,
  );
}

export function summarize(
  split: Split,
  cases: readonly TestCase[],
  results: readonly TestResult[],
): Summary {
  if (cases.length === 0) throw new Error(`there are no ${split} cases to summarise`);
  if (cases.some((c) => c.split !== split) || results.some((r) => r.split !== split)) {
    throw new Error(`a ${split} summary holds only ${split} cases`);
  }
  const agents = [...new Set(results.map((result) => result.agent))];
  if (agents.length > 1) throw new Error(`a summary covers one agent, not ${agents.join(", ")}`);
  refuseIncomplete(split, cases, results);

  const count = (matches: (result: TestResult) => boolean) => results.filter(matches).length;
  const turnMs = results.flatMap((result) => result.turn_ms).sort((a, b) => a - b);
  const cost = results.reduce((sum, result) => sum + result.cost_usd, 0);
  return {
    split,
    agent: agents[0] ?? "",
    cases: results.length,
    passed: count(passed),
    resolved_correctly: count((r) => passed(r) && r.observed === "resolved"),
    handed_over: count((r) => r.observed === "handed_over"),
    wrong_action: count(tookWrongAction),
    blocked_attempt: count((r) => r.blocked_attempts.length > 0),
    turn_ms_p50: percentile(turnMs, 0.5),
    turn_ms_p95: percentile(turnMs, 0.95),
    cost_per_conversation_usd: cost / results.length,
  };
}

export function formatSummary(summary: Summary): string {
  const share = (n: number) => `${n}/${summary.cases} (${Math.round((100 * n) / summary.cases)}%)`;
  return [
    `${summary.split}: ${summary.cases} conversations`,
    `  passed every check     ${share(summary.passed)}`,
    `  resolved correctly     ${share(summary.resolved_correctly)}`,
    `  handover rate          ${share(summary.handed_over)}`,
    `  wrong-action rate      ${share(summary.wrong_action)}`,
    `  blocked attempts       ${share(summary.blocked_attempt)}`,
    `  agent turn time        nearest-rank median ${summary.turn_ms_p50.toFixed(2)} ms, p95 ${summary.turn_ms_p95.toFixed(2)} ms`,
    `  cost per conversation  $${summary.cost_per_conversation_usd.toFixed(4)}`,
  ].join("\n");
}
