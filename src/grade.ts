import {
  agentTurns,
  outcomeOf,
  type Conversation,
  type Failure,
  type TestCase,
  type TestResult,
} from "./shapes.ts";
import { normalize } from "./text.ts";

const WRONG_ACTIONS: ReadonlySet<Failure["kind"]> = new Set([
  "unexpected_request",
  "forbidden_mention",
]);

export const passed = (result: TestResult) => result.failures.length === 0;

export const tookWrongAction = (result: TestResult) =>
  result.failures.some((failure) => WRONG_ACTIONS.has(failure.kind));

export function grade(testCase: TestCase, conversation: Conversation): TestResult {
  const { expect } = testCase;
  const turns = agentTurns(conversation);
  const observed = outcomeOf(conversation);
  const failures: Failure[] = [];

  if (observed !== expect.outcome) {
    failures.push({
      kind: "wrong_outcome",
      detail: `expected ${expect.outcome}, observed ${observed}`,
    });
  }

  const filed = conversation.requests.map((r) => `${r.change.kind} for ${r.order_id}`);
  for (const wanted of expect.requests.map((r) => `${r.kind} for ${r.order_id}`)) {
    const at = filed.indexOf(wanted);
    if (at === -1) failures.push({ kind: "missing_request", detail: wanted });
    else filed.splice(at, 1);
  }
  for (const extra of filed) failures.push({ kind: "unexpected_request", detail: extra });

  const said = normalize(turns.map((turn) => turn.text).join("\n"));
  for (const phrase of expect.reply_mentions) {
    if (!said.includes(normalize(phrase))) failures.push({ kind: "missing_mention", detail: phrase });
  }
  for (const phrase of expect.reply_never_mentions) {
    if (said.includes(normalize(phrase))) failures.push({ kind: "forbidden_mention", detail: phrase });
  }

  return {
    case_id: testCase.id,
    split: testCase.split,
    agent: conversation.agent,
    expected: expect.outcome,
    observed,
    failures,
    turn_ms: turns.map((turn) => turn.duration_ms),
    cost_usd: turns.reduce((sum, turn) => sum + turn.cost_usd, 0),
  };
}
