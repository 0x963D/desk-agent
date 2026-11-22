import { expect, test } from "vitest";
import type { TestResult } from "../src/shapes.ts";
import { formatSummary, summarize } from "../src/summary.ts";

const result = (overrides: Partial<TestResult>): TestResult => ({
  case_id: "example",
  split: "tuning",
  agent: "scripted",
  expected: "resolved",
  observed: "resolved",
  failures: [],
  turn_ms: [100],
  cost_usd: 0,
  ...overrides,
});

const tuning: TestResult[] = [
  result({ turn_ms: [100, 300], cost_usd: 0.01 }),
  result({ expected: "refused", observed: "refused", turn_ms: [200], cost_usd: 0.02 }),
  result({
    observed: "handed_over",
    failures: [{ kind: "wrong_outcome", detail: "expected resolved, observed handed_over" }],
    turn_ms: [400],
    cost_usd: 0.03,
  }),
  result({
    failures: [{ kind: "unexpected_request", detail: "refund for EX-1003" }],
    turn_ms: [2000],
    cost_usd: 0.06,
  }),
];

test("a split's summary counts outcomes and reports turn time and cost per conversation", () => {
  expect(summarize(tuning)).toEqual([
    {
      split: "tuning",
      cases: 4,
      passed: 2,
      resolved_correctly: 1,
      handed_over: 1,
      wrong_action: 1,
      turn_ms_p50: 300,
      turn_ms_p95: 2000,
      cost_per_conversation_usd: 0.03,
    },
  ]);
});

test("each split is summarised on its own results", () => {
  const heldOut = result({ split: "held-out", turn_ms: [50], cost_usd: 0.5 });

  const summaries = summarize([...tuning, heldOut]);

  expect(summaries.map((s) => [s.split, s.cases, s.turn_ms_p95])).toEqual([
    ["tuning", 4, 2000],
    ["held-out", 1, 50],
  ]);
});

test("the printed summary shows each rate as a count and a share", () => {
  const [summary] = summarize(tuning);

  expect(formatSummary(summary!)).toBe(
    [
      "tuning: 4 conversations",
      "  passed every check     2/4 (50%)",
      "  resolved correctly     1/4 (25%)",
      "  handover rate          1/4 (25%)",
      "  wrong-action rate      1/4 (25%)",
      "  agent turn time        median 300.00 ms, p95 2000.00 ms",
      "  cost per conversation  $0.0300",
    ].join("\n"),
  );
});
