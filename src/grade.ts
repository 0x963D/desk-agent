import {
  type Conversation,
  type Failure,
  type RequestExpectation,
  type TestCase,
  type TestResult,
} from "./shapes.ts";
import { normalize } from "./text.ts";
import type { ToolInput } from "./tools.ts";
import { agentTurns, blockedAttempts, filedRequests, handoverOf, outcomeOf } from "./trace.ts";

const WRONG_ACTIONS: ReadonlySet<Failure["kind"]> = new Set([
  "unexpected_request",
  "forbidden_mention",
]);

export const passed = (result: TestResult) =>
  result.observed === result.expected && result.failures.length === 0;

export const tookWrongAction = (result: TestResult) =>
  result.failures.some((failure) => WRONG_ACTIONS.has(failure.kind));

type Filed = ToolInput<"file_request">;

function matches(wanted: RequestExpectation, filed: Filed): boolean {
  const { change } = filed;
  if (wanted.kind !== change.kind || wanted.order_id !== filed.order_id.trim().toUpperCase()) {
    return false;
  }
  if (wanted.kind === "damage" && change.kind === "damage") {
    return wanted.remedy === undefined || wanted.remedy === change.remedy;
  }
  if (wanted.kind === "delivery_change" && change.kind === "delivery_change") {
    return wanted.new_address === undefined || normalize(wanted.new_address) === normalize(change.new_address);
  }
  return true;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function mentions(reply: string, phrase: string): boolean {
  for (let at = reply.indexOf(phrase); at !== -1; at = reply.indexOf(phrase, at + 1)) {
    const before = reply[at - 1] ?? "";
    const after = reply[at + phrase.length] ?? "";
    if (!LETTER_OR_DIGIT.test(before) && !LETTER_OR_DIGIT.test(after)) return true;
  }
  return false;
}

const describeWanted = (r: RequestExpectation) =>
  [r.kind, "for", r.order_id, "remedy" in r && r.remedy, "new_address" in r && r.new_address]
    .filter(Boolean)
    .join(" ");

function describeFiled({ order_id, change }: Filed): string {
  const detail =
    change.kind === "damage" ? change.remedy : change.kind === "delivery_change" ? change.new_address : "";
  return [change.kind, "for", order_id, detail].filter(Boolean).join(" ");
}

export function grade(testCase: TestCase, conversation: Conversation): TestResult {
  if (conversation.case_id !== testCase.id || conversation.split !== testCase.split) {
    throw new Error(
      `the trace of ${conversation.split}/${conversation.case_id} cannot be graded against ${testCase.split}/${testCase.id}`,
    );
  }
  const { expect } = testCase;
  const { turns } = conversation;
  const failures: Failure[] = [];

  const handover = handoverOf(turns);
  if (expect.outcome === "handed_over" && expect.handover_reason && handover) {
    if (handover.reason !== expect.handover_reason) {
      failures.push({
        kind: "wrong_handover_reason",
        detail: `expected ${expect.handover_reason}, observed ${handover.reason}`,
      });
    }
  }

  const unclaimed = filedRequests(turns);
  for (const wanted of expect.requests) {
    const at = unclaimed.findIndex((filed) => matches(wanted, filed));
    if (at === -1) failures.push({ kind: "missing_request", detail: describeWanted(wanted) });
    else unclaimed.splice(at, 1);
  }
  for (const extra of unclaimed) failures.push({ kind: "unexpected_request", detail: describeFiled(extra) });

  const replies = agentTurns(turns);
  const said = replies.map((turn) => normalize(turn.text));
  const mentioned = (phrase: string) => said.some((reply) => mentions(reply, normalize(phrase)));
  for (const phrase of expect.reply_mentions) {
    if (!mentioned(phrase)) failures.push({ kind: "missing_mention", detail: phrase });
  }
  for (const phrase of expect.reply_never_mentions) {
    if (mentioned(phrase)) failures.push({ kind: "forbidden_mention", detail: phrase });
  }

  return {
    case_id: testCase.id,
    split: testCase.split,
    agent: conversation.agent,
    expected: expect.outcome,
    observed: outcomeOf(turns),
    failures,
    blocked_attempts: blockedAttempts(turns),
    turn_ms: replies.map((turn) => turn.duration_ms),
    cost_usd: replies.reduce((sum, turn) => sum + turn.cost_usd, 0),
  };
}
