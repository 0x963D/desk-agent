import { z } from "zod";

export const Split = z.enum(["tuning", "held-out"]);
export type Split = z.infer<typeof Split>;

export const Outcome = z.enum(["resolved", "handed_over", "refused"]);
export type Outcome = z.infer<typeof Outcome>;

export const ToolName = z.enum([
  "lookup_order",
  "lookup_account",
  "check_policy",
  "request_approval",
  "hand_over_to_human",
]);
export type ToolName = z.infer<typeof ToolName>;

export const ChangeKind = z.enum(["refund", "delivery_change"]);

export const ApprovalRequest = z.object({
  order_id: z.string(),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("refund"), reason: z.string() }),
    z.object({ kind: z.literal("delivery_change"), new_address: z.string() }),
  ]),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const Handover = z.object({
  reason: z.enum(["customer_asked", "out_of_scope", "needs_human_judgement"]),
  summary: z.string().min(1),
  order_id: z.string().optional(),
});
export type Handover = z.infer<typeof Handover>;

export const ToolCall = z.object({
  name: ToolName,
  input: z.unknown(),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.enum(["invalid_input", "not_found"]) }),
  ]),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const Turn = z.discriminatedUnion("role", [
  z.object({ role: z.literal("customer"), text: z.string() }),
  z.object({
    role: z.literal("agent"),
    text: z.string(),
    status: z.enum(["open", "resolved", "refused"]),
    tool_calls: z.array(ToolCall),
    duration_ms: z.number().nonnegative(),
    cost_usd: z.number().nonnegative(),
  }),
]);
export type Turn = z.infer<typeof Turn>;
export type AgentTurn = Extract<Turn, { role: "agent" }>;

export const Conversation = z.object({
  case_id: z.string(),
  agent: z.string(),
  turns: z.array(Turn),
  requests: z.array(ApprovalRequest),
  handover: Handover.nullable(),
});
export type Conversation = z.infer<typeof Conversation>;

export const TestCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  split: Split,
  language: z.enum(["ro", "en"]),
  customer_id: z.string(),
  summary: z.string().min(1),
  turns: z.array(z.string().min(1)).min(1),
  expect: z.strictObject({
    outcome: Outcome,
    requests: z.array(z.strictObject({ kind: ChangeKind, order_id: z.string() })).default([]),
    reply_mentions: z.array(z.string().min(1)).default([]),
    reply_never_mentions: z.array(z.string().min(1)).default([]),
  }),
});
export type TestCase = z.infer<typeof TestCase>;

export const ObservedOutcome = z.enum([...Outcome.options, "unfinished"]);
export type ObservedOutcome = z.infer<typeof ObservedOutcome>;

export const Failure = z.object({
  kind: z.enum([
    "wrong_outcome",
    "missing_request",
    "unexpected_request",
    "missing_mention",
    "forbidden_mention",
  ]),
  detail: z.string(),
});
export type Failure = z.infer<typeof Failure>;

export const TestResult = z.object({
  case_id: z.string(),
  split: Split,
  agent: z.string(),
  expected: Outcome,
  observed: ObservedOutcome,
  failures: z.array(Failure),
  turn_ms: z.array(z.number().nonnegative()),
  cost_usd: z.number().nonnegative(),
});
export type TestResult = z.infer<typeof TestResult>;

export function agentTurns(conversation: Conversation): AgentTurn[] {
  return conversation.turns.filter((turn) => turn.role === "agent");
}

export function outcomeOf(conversation: Conversation): ObservedOutcome {
  if (conversation.handover) return "handed_over";
  const status = agentTurns(conversation).at(-1)?.status ?? "open";
  return status === "open" ? "unfinished" : status;
}
