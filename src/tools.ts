import { z } from "zod";
import { ApprovalRequest, ChangeKind, Handover, type ToolName } from "./shapes.ts";

const orderBase = {
  order_id: z.string(),
  customer_id: z.string(),
  items: z.array(z.string()).min(1),
  total_ron: z.number().positive(),
  delivery_address: z.string(),
};

export const Order = z.discriminatedUnion("status", [
  z.object({ ...orderBase, status: z.literal("placed") }),
  z.object({ ...orderBase, status: z.literal("shipped"), tracking_number: z.string() }),
  z.object({ ...orderBase, status: z.literal("delivered"), delivered_on: z.iso.date() }),
]);
export type Order = z.infer<typeof Order>;

export const Account = z.object({
  customer_id: z.string(),
  name: z.string(),
  email: z.email(),
  phone: z.string(),
  address: z.string(),
});
export type Account = z.infer<typeof Account>;

export const contracts = {
  lookup_order: {
    description: "Look up one order by its number: status, items, delivery address and owner.",
    input: z.object({ order_id: z.string() }),
    output: Order,
  },
  lookup_account: {
    description: "Look up one customer account: name and contact details.",
    input: z.object({ customer_id: z.string() }),
    output: Account,
  },
  check_policy: {
    description: "Check whether shop policy allows a refund or a delivery change for an order.",
    input: z.object({ kind: ChangeKind, order_id: z.string() }),
    output: z.object({
      allowed: z.boolean(),
      reason: z.enum([
        "within_return_window",
        "outside_return_window",
        "not_delivered_yet",
        "not_shipped_yet",
        "already_shipped",
      ]),
    }),
  },
  request_approval: {
    description:
      "File a refund or delivery-change request. Nothing changes until a human approves it.",
    input: ApprovalRequest,
    output: z.object({ request_id: z.string(), status: z.literal("pending_approval") }),
  },
  hand_over_to_human: {
    description: "Hand the conversation to a human colleague. The agent stops replying.",
    input: Handover,
    output: z.object({ handover_id: z.string() }),
  },
} satisfies Record<ToolName, { description: string; input: z.ZodType; output: z.ZodType }>;

export type ToolInput<K extends ToolName> = z.infer<(typeof contracts)[K]["input"]>;
export type ToolOutput<K extends ToolName> = z.infer<(typeof contracts)[K]["output"]>;

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "invalid_input" | "not_found" };

export type Tools = {
  call<K extends ToolName>(name: K, input: unknown): Promise<ToolResult<ToolOutput<K>>>;
};
