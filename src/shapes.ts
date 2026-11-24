import { z } from "zod";

export const Split = z.enum(["tuning", "held-out", "final"]);
export type Split = z.infer<typeof Split>;

// The sets that `pnpm score` runs. The held-out set is the validation set, and the final set is the one the README quotes.
export const ScoredSet = Split.exclude(["tuning"]);
export type ScoredSet = z.infer<typeof ScoredSet>;

export const Language = z.enum(["ro", "en"]);
export type Language = z.infer<typeof Language>;

export const Outcome = z.enum(["resolved", "handed_over", "refused"]);
export type Outcome = z.infer<typeof Outcome>;

export const ObservedOutcome = z.enum([...Outcome.options, "unfinished"]);
export type ObservedOutcome = z.infer<typeof ObservedOutcome>;

export const Category = z.enum([
  "order-status",
  "delivery-change",
  "inside-policy",
  "outside-policy",
  "damage",
  "identity",
  "injection",
  "person-needed",
  "shop-question",
]);

export const OrderId = z.string().regex(/^SC-\d{4}$/, "an order number is SC- and four digits");
export const Email = z.string().regex(/^[^@\s]+@example\.com$/i, "every email is at example.com");
const IsoDate = z.iso.date();

const orderFields = {
  order_id: OrderId,
  email: Email,
  customer_name: z.string().min(1),
  placed_on: IsoDate,
  items: z
    .array(
      z.strictObject({
        title: z.string().min(1),
        kind: z.enum(["open", "limited", "commission"]),
        size: z.string().min(1),
        price_ron: z.number().positive(),
      }),
    )
    .min(1),
  total_ron: z.number().positive(),
  delivery: z.strictObject({ address: z.string().min(1), country: z.string().regex(/^[A-Z]{2}$/) }),
  gift_note: z.string().optional(),
};
const TrackingUrl = z.url({ hostname: /^curier\.example$/ });

export const Order = z
  .discriminatedUnion("status", [
    z.strictObject({ ...orderFields, status: z.literal("paid") }),
    z.strictObject({ ...orderFields, status: z.literal("in_production") }),
    z.strictObject({ ...orderFields, status: z.literal("shipped"), tracking_url: TrackingUrl }),
    z.strictObject({
      ...orderFields,
      status: z.literal("delivered"),
      tracking_url: TrackingUrl,
      delivered_on: IsoDate,
    }),
  ])
  .refine(
    (order) => Math.abs(order.items.reduce((sum, item) => sum + item.price_ron, 0) - order.total_ron) < 0.005,
    { message: "total_ron must equal the sum of the item prices", path: ["total_ron"] },
  )
  .refine((order) => order.status !== "delivered" || order.delivered_on >= order.placed_on, {
    message: "delivered_on cannot come before placed_on",
    path: ["delivered_on"],
  });
export type Order = z.infer<typeof Order>;

export const RequestKind = z.enum(["cancellation", "return", "damage", "delivery_change"]);
export type RequestKind = z.infer<typeof RequestKind>;

export const PolicyTopic = z.enum([
  "production",
  "delivery",
  "payment",
  ...RequestKind.options,
  "large_refund",
  "commissioned_work",
  "limited_drops",
  "commissions_and_bookings",
  "health",
]);
export type PolicyTopic = z.infer<typeof PolicyTopic>;

const RuleText = z.strictObject({ ro: z.string().min(1), en: z.string().min(1) });

export const Shop = z.strictObject({
  business_date: IsoDate,
  return_window_days: z.number().int().positive(),
  damage_window_days: z.number().int().positive(),
  person_decides_refunds_above_ron: z.number().positive(),
  rules: z.record(PolicyTopic, RuleText),
});
export type Shop = z.infer<typeof Shop>;

export const Remedy = z.enum(["reprint", "refund"]);
export type Remedy = z.infer<typeof Remedy>;

const FilledText = z.string().trim().min(1, "must hold text, not only spaces");

export const Change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancellation") }),
  z.object({ kind: z.literal("return") }),
  z.object({
    kind: z.literal("damage"),
    description: FilledText,
    remedy: Remedy.optional().describe(
      "Only when the customer said which they want, a reprint or a refund. Leave it out otherwise, because staff decide after a photo.",
    ),
  }),
  z.object({ kind: z.literal("delivery_change"), new_address: FilledText }),
]);
export type Change = z.infer<typeof Change>;

// What `amend_request` may change on a filed request: a damage claim's remedy or a delivery
// change's address. A cancellation and a return carry nothing to change.
export const Amendment = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("damage"), remedy: Remedy.describe("The remedy the customer now says they want.") }),
    z.object({ kind: z.literal("delivery_change"), new_address: FilledText }),
  ],
  { error: "Only a damage claim's remedy or a delivery change's address can be amended. A cancellation or a return has nothing to amend." },
);
export type Amendment = z.infer<typeof Amendment>;

// The request on file after an amendment of the same kind: the amended field replaced, the rest kept.
export const amended = (change: Change, amendment: Amendment): Change => Change.parse({ ...change, ...amendment });

export const HandoverReason = z.enum([
  "customer_asked",
  "complaint",
  "commission_or_booking",
  "staff_decision",
  "system_failure",
]);

export const Handover = z.object({
  reason: HandoverReason,
  summary: FilledText,
  order_id: z.string().optional(),
});
export type Handover = z.infer<typeof Handover>;

export const DenialReason = z.enum([
  "production_started",
  "already_shipped",
  "not_delivered",
  "window_closed",
  "commissioned_work",
  "large_refund",
  "duplicate",
]);
export type DenialReason = z.infer<typeof DenialReason>;

export const ToolError = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("invalid_input"), message: z.string() }),
  z.strictObject({ code: z.literal("not_found"), message: z.string() }),
  z.strictObject({ code: z.literal("policy_denied"), reason: DenialReason, message: z.string() }),
  z.strictObject({ code: z.literal("unavailable"), message: z.string() }),
]);
export type ToolError = z.infer<typeof ToolError>;

export const ToolName = z.enum([
  "lookup_order",
  "lookup_account",
  "check_policy",
  "file_request",
  "amend_request",
  "hand_over",
]);
export type ToolName = z.infer<typeof ToolName>;

export const CallOutput = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: ToolError }),
]);

export const ToolCall = z.strictObject({ name: ToolName, input: z.unknown(), output: CallOutput });
export type ToolCall = z.infer<typeof ToolCall>;

export const Turn = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("customer"), text: z.string() }),
  z.strictObject({
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

export const Conversation = z.strictObject({
  conversation_id: z.string(),
  case_id: z.string(),
  split: Split,
  agent: z.string(),
  turns: z.array(Turn),
});
export type Conversation = z.infer<typeof Conversation>;

// The log of one `pnpm chat` session, saved under traces/chat/. Every string in its turns has
// passed through `redact`, so it holds no email, phone number, card number, IBAN or street, and no
// customer name that a function returned in the chat.
export const ChatLog = z.strictObject({
  conversation_id: z.string(),
  agent: z.string(),
  orders: z.literal("tuning"),
  replay_of: z.string().optional(),
  started_at: z.iso.datetime(),
  turns: z.array(Turn),
});
export type ChatLog = z.infer<typeof ChatLog>;

export const RequestExpectation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancellation"), order_id: OrderId }),
  z.strictObject({ kind: z.literal("return"), order_id: OrderId }),
  z.strictObject({ kind: z.literal("damage"), order_id: OrderId, remedy: Remedy.optional() }),
  z.strictObject({
    kind: z.literal("delivery_change"),
    order_id: OrderId,
    new_address: z.string().min(1).optional(),
  }),
]);
export type RequestExpectation = z.infer<typeof RequestExpectation>;

const Phrases = z.array(z.string().min(1)).default([]);
const Requests = z
  .array(RequestExpectation)
  .default([])
  .refine(
    (requests) => new Set(requests.map((r) => `${r.kind} ${r.order_id}`)).size === requests.length,
    "a case expects each kind at most once per order",
  );

export const Expectation = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("resolved"),
    requests: Requests,
    reply_mentions: Phrases,
    reply_never_mentions: Phrases,
  }),
  z.strictObject({
    outcome: z.literal("handed_over"),
    handover_reason: HandoverReason.optional(),
    requests: Requests,
    reply_mentions: Phrases,
    reply_never_mentions: Phrases,
  }),
  z.strictObject({
    outcome: z.literal("refused"),
    requests: z.array(RequestExpectation).max(0, "a refused case files nothing").default([]),
    reply_mentions: Phrases,
    reply_never_mentions: Phrases,
  }),
]);
export type Expectation = z.infer<typeof Expectation>;

export const TestCase = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/),
    split: Split,
    language: Language,
    category: Category,
    summary: z.string().min(1),
    outage: z.boolean().default(false),
    turns: z.array(z.string().min(1)).min(1).max(4),
    expect: Expectation,
  })
  .refine((c) => c.id.startsWith(`${c.language}-`), {
    message: "the id starts with the language, such as ro- or en-",
    path: ["id"],
  });
export type TestCase = z.infer<typeof TestCase>;

export const Failure = z.strictObject({
  kind: z.enum([
    "wrong_handover_reason",
    "missing_request",
    "unexpected_request",
    "missing_mention",
    "forbidden_mention",
    "empty_reply",
    "wrong_language",
  ]),
  detail: z.string(),
});
export type Failure = z.infer<typeof Failure>;

export const TestResult = z.strictObject({
  case_id: z.string(),
  split: Split,
  agent: z.string(),
  expected: Outcome,
  observed: ObservedOutcome,
  failures: z.array(Failure),
  blocked_attempts: z.array(z.string()),
  turn_ms: z.array(z.number().nonnegative()),
  cost_usd: z.number().nonnegative(),
});
export type TestResult = z.infer<typeof TestResult>;

export const Criterion = z.enum(["outcome", "requests", "promises", "privacy", "facts", "handover", "reply"]);
export type Criterion = z.infer<typeof Criterion>;

const criterionFields = Object.fromEntries(Criterion.options.map((name) => [name, z.boolean()])) as Record<
  Criterion,
  z.ZodBoolean
>;

export const Verdict = z
  .strictObject({ id: z.string().min(1), acceptable: z.boolean(), ...criterionFields, note: FilledText })
  .refine((v) => v.acceptable === Criterion.options.every((name) => v[name]), {
    message: "acceptable is true exactly when no criterion fails",
    path: ["acceptable"],
  })
  .refine((v) => v.acceptable || /\bturn \d+\b/i.test(v.note), {
    message: "a note on a failure names the turn, such as turn 4",
    path: ["note"],
  });
export type Verdict = z.infer<typeof Verdict>;

export const AuditKey = z
  .strictObject({
    seed: z.string().min(1),
    conversations: z.array(
      z.strictObject({ id: z.string().min(1), agent: z.string(), run: z.string(), case_id: z.string() }),
    ),
  })
  .refine((key) => new Set(key.conversations.map((c) => c.id)).size === key.conversations.length, {
    message: "each id appears once",
    path: ["conversations"],
  });
export type AuditKey = z.infer<typeof AuditKey>;
