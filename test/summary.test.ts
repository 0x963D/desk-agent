import { expect, test } from "vitest";
import type { TestResult } from "../src/shapes.ts";
import { formatSummary, summarize } from "../src/summary.ts";
import { caseExpecting } from "./helpers.ts";

const result = (case_id: string, overrides: Partial<TestResult> = {}): TestResult => ({
  case_id,
  split: "tuning",
  agent: "scripted",
  expected: "resolved",
  observed: "resolved",
  failures: [],
  blocked_attempts: [],
  turn_ms: [100],
  cost_usd: 0,
  ...overrides,
});

const caseNamed = (id: string) => ({ ...caseExpecting({ outcome: "resolved" }), id });
const cases = ["en-a", "en-b", "en-c", "en-d"].map(caseNamed);

const tuning: TestResult[] = [
  result("en-a", { turn_ms: [100, 300], cost_usd: 0.01 }),
  result("en-b", {
    expected: "refused",
    observed: "refused",
    blocked_attempts: ["return for SC-1005: window_closed"],
    turn_ms: [200],
    cost_usd: 0.02,
  }),
  result("en-c", { observed: "handed_over", turn_ms: [400], cost_usd: 0.03 }),
  result("en-d", {
    failures: [{ kind: "unexpected_request", detail: "return for SC-1004" }],
    turn_ms: [2000],
    cost_usd: 0.06,
  }),
];

test("a split's summary counts outcomes, wrong actions and blocked attempts", () => {
  expect(summarize("tuning", cases, tuning)).toEqual({
    split: "tuning",
    agent: "scripted",
    cases: 4,
    passed: 2,
    resolved_correctly: 1,
    handed_over: 1,
    wrong_action: 1,
    blocked_attempt: 1,
    turn_ms_p50: 300,
    turn_ms_p95: 2000,
    cost_per_conversation_usd: 0.03,
  });
});

test("the printed summary shows each rate as a count and a share", () => {
  expect(formatSummary(summarize("tuning", cases, tuning))).toBe(
    [
      "tuning: 4 conversations",
      "  passed every check     2/4 (50%)",
      "  resolved correctly     1/4 (25%)",
      "  handover rate          1/4 (25%)",
      "  wrong-action rate      1/4 (25%)",
      "  blocked attempts       1/4 (25%)",
      "  agent turn time        nearest-rank median 300.00 ms, p95 2000.00 ms",
      "  cost per conversation  $0.0300",
    ].join("\n"),
  );
});

test("a run that misses a case of its split cannot be summarised", () => {
  expect(() => summarize("tuning", cases, tuning.slice(0, 3))).toThrow(
    "the run covers 3 of 4 tuning cases (missing: en-d)",
  );
});

test("a run that holds a case twice or a case the split does not have cannot be summarised", () => {
  const results = [...tuning, result("en-a"), result("en-z")];

  expect(() => summarize("tuning", cases, results)).toThrow(/not tuning cases: en-z; graded twice: en-a/);
});

test("a summary covers one agent", () => {
  const mixed = tuning.map((r, at) => (at === 0 ? { ...r, agent: "other" } : r));

  expect(() => summarize("tuning", cases, mixed)).toThrow("one agent");
});
