import { z } from "zod";
import {
  Change,
  DenialReason,
  Handover,
  Order,
  PolicyTopic,
  type ToolError,
  type ToolName,
} from "./shapes.ts";

const order_id = z.string().min(1).describe("The order number, SC- and four digits, such as SC-1007.");
const email = z.string().min(1).describe("The email the order was placed with.");

export const contracts = {
  lookup_order: {
    description:
      "Return one order: status, items, delivery details and tracking link. Needs the order number and the email on the order.",
    input: z.object({ order_id, email }),
    output: Order,
  },
  lookup_account: {
    description:
      "List the orders placed with an email. Needs one order number placed with that email, to verify the customer.",
    input: z.object({ email, order_id }),
    output: z.object({
      orders: z.array(
        z.object({
          order_id: z.string(),
          status: z.string(),
          placed_on: z.string(),
          total_ron: z.number(),
        }),
      ),
    }),
  },
  check_policy: {
    description:
      "Return the shop rule on one topic, in Romanian and English. For a cancellation, return, damage or delivery change, give the order number and email together to learn whether the policy allows that request for that order.",
    input: z
      .object({ topic: PolicyTopic, order_id: order_id.optional(), email: email.optional() })
      .refine((input) => (input.order_id === undefined) === (input.email === undefined), {
        message: "give order_id and email together, or neither",
      }),
    output: z.object({
      topic: PolicyTopic,
      rule: z.object({ ro: z.string(), en: z.string() }),
      decision: z
        .discriminatedUnion("allowed", [
          z.object({ allowed: z.literal(true) }),
          z.object({ allowed: z.literal(false), reason: DenialReason }),
        ])
        .optional(),
    }),
  },
  file_request: {
    description:
      "File one cancellation, return, damage claim or delivery change for staff approval. Nothing changes until staff approve it. The function refuses what the policy forbids.",
    input: z.object({ order_id, email, change: Change }),
    output: z.object({ request_id: z.string(), status: z.literal("pending_approval") }),
  },
  hand_over: {
    description:
      "Pass the conversation to a person, with a reason and a summary the person can act on without rereading the chat. Always available.",
    input: Handover,
    output: z.object({ handover_id: z.string() }),
  },
} satisfies Record<ToolName, { description: string; input: z.ZodType; output: z.ZodType }>;

export type ToolInput<K extends ToolName> = z.infer<(typeof contracts)[K]["input"]>;
export type ToolOutput<K extends ToolName> = z.infer<(typeof contracts)[K]["output"]>;

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

export type Tools = {
  call<K extends ToolName>(name: K, input: unknown): Promise<ToolResult<ToolOutput<K>>>;
};
