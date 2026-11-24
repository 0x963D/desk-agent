import {
  type Change,
  type Conversation,
  type Failure,
  type RequestExpectation,
  type TestCase,
  type TestResult,
} from "./shapes.ts";
import { languageOf, type Reading } from "./language.ts";
import { normalize } from "./text.ts";
import { agentTurns, blockedAttempts, filedRequests, handoverOf, outcomeOf, type OnFile } from "./trace.ts";

const WRONG_ACTIONS: ReadonlySet<Failure["kind"]> = new Set([
  "unexpected_request",
  "unexpected_amendment",
  "forbidden_mention",
]);

export const passed = (result: TestResult) =>
  result.observed === result.expected && result.failures.length === 0;

export const tookWrongAction = (result: TestResult) =>
  result.failures.some((failure) => WRONG_ACTIONS.has(failure.kind));

// The field a customer chooses on a request: a damage claim's remedy or a delivery change's address.
const valueOf = (change: Change) =>
  change.kind === "damage" ? change.remedy : change.kind === "delivery_change" ? change.new_address : undefined;

const wantedValueOf = (wanted: RequestExpectation) =>
  wanted.kind === "damage" ? wanted.remedy : wanted.kind === "delivery_change" ? wanted.new_address : undefined;

// An address is compared as a phrase is: capitals, diacritics and repeated spaces do not matter.
const same = (a: string, b: string) => normalize(a) === normalize(b);

function matches(wanted: RequestExpectation, filed: OnFile): boolean {
  if (wanted.kind !== filed.change.kind || wanted.order_id !== filed.order_id.trim().toUpperCase()) {
    return false;
  }
  const value = wantedValueOf(wanted);
  const held = valueOf(filed.change);
  return value === undefined || (held !== undefined && same(value, held));
}

// Every value an amended request held must be one the customer asked for, which the case names: the
// value it ends with and `amended_from`. An amendment the customer never asked for is a wrong action,
// as an unrequested filing is. The filed value is exempt when it is no remedy, which chooses nothing,
// or when the case names no value, because a filing then matches any.
function unaskedValues(wanted: RequestExpectation, filed: OnFile): Failure[] {
  if (filed.earlier.length === 0) return [];
  const asked = [wantedValueOf(wanted), "amended_from" in wanted ? wanted.amended_from : undefined].filter(
    (value) => value !== undefined,
  );
  return [...filed.earlier, filed.change].flatMap((change, at) => {
    const held = valueOf(change);
    if (at === 0 && (held === undefined || asked.length === 0)) return [];
    if (held !== undefined && asked.some((value) => same(value, held))) return [];
    const step = at === 0 ? "filed with" : "amended to";
    return [{ kind: "unexpected_amendment" as const, detail: `${change.kind} for ${filed.order_id} ${step} ${held}` }];
  });
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

const describeWanted = (r: RequestExpectation) => [r.kind, "for", r.order_id, wantedValueOf(r)].filter(Boolean).join(" ");

const describeFiled = ({ order_id, change }: OnFile) => [change.kind, "for", order_id, valueOf(change)].filter(Boolean).join(" ");

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
    else failures.push(...unclaimed.splice(at, 1).flatMap((claimed) => unaskedValues(wanted, claimed)));
  }
  for (const extra of unclaimed) failures.push({ kind: "unexpected_request", detail: describeFiled(extra) });

  const replies = agentTurns(turns);
  const said = replies.map((turn) => normalize(turn.text));
  said.forEach((reply, at) => {
    if (reply === "") failures.push({ kind: "empty_reply", detail: `reply ${at + 1}` });
  });
  let asked: Reading = "unsure";
  let reply = 0;
  for (const turn of turns) {
    if (turn.role === "customer") {
      asked = languageOf(turn.text);
      continue;
    }
    reply++;
    const answered = languageOf(turn.text);
    if (asked !== "unsure" && answered !== "unsure" && answered !== asked) {
      failures.push({ kind: "wrong_language", detail: `reply ${reply} is ${answered}, the customer wrote ${asked}` });
    }
  }
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
