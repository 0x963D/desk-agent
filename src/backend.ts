import { z } from "zod";
import {
  RequestKind,
  type DenialReason,
  type Order,
  type Remedy,
  type Shop,
  type ToolError,
  type ToolName,
} from "./shapes.ts";
import { contracts, type ToolInput, type ToolOutput, type ToolResult, type Tools } from "./tools.ts";

export type World = { shop: Shop; orders: Order[] };

type Handlers = { [K in ToolName]: (input: ToolInput<K>) => ToolResult<ToolOutput<K>> };

const DAY_MS = 86_400_000;

const fail = (error: ToolError) => ({ ok: false, error }) as const;

const NOT_FOUND = fail({
  code: "not_found",
  message: "No order matches that order number and email. Ask the customer to check both.",
});

const UNAVAILABLE = fail({
  code: "unavailable",
  message: "The shop system is not answering. Hand the conversation over with reason system_failure.",
});

function denialMessage(reason: DenialReason, kind: RequestKind, shop: Shop): string {
  switch (reason) {
    case "production_started":
      return "Production has started, so the order can no longer be cancelled.";
    case "already_shipped":
      return "The order has shipped, so the delivery address can no longer change.";
    case "not_delivered":
      return "The order has not been delivered yet.";
    case "window_closed":
      return `More than ${windowOf(kind, shop)} days have passed since delivery, so the window for this request has closed.`;
    case "commissioned_work":
      return "Commissioned work cannot be returned.";
    case "large_refund":
      return `A person decides any refund above ${shop.person_decides_refunds_above_ron} lei. Hand the conversation over with reason staff_decision.`;
    case "duplicate":
      return "A request of this kind is already on file for this order.";
  }
}

const windowOf = (kind: RequestKind, shop: Shop) =>
  kind === "return" ? shop.return_window_days : shop.damage_window_days;

function refundOf(kind: RequestKind, order: Order, remedy?: Remedy): number {
  switch (kind) {
    case "cancellation":
    case "return":
      return order.total_ron;
    case "damage":
      return remedy === "refund" ? order.total_ron : 0;
    case "delivery_change":
      return 0;
  }
}

function denial(
  shop: Shop,
  order: Order,
  kind: RequestKind,
  remedy: Remedy | undefined,
  filed: ReadonlySet<string>,
): DenialReason | undefined {
  const daysSinceDelivery =
    order.status === "delivered"
      ? (Date.parse(shop.business_date) - Date.parse(order.delivered_on)) / DAY_MS
      : undefined;
  switch (kind) {
    case "cancellation":
      if (order.status !== "paid") return "production_started";
      break;
    case "delivery_change":
      if (order.status === "shipped" || order.status === "delivered") return "already_shipped";
      break;
    case "return":
    case "damage":
      if (daysSinceDelivery === undefined) return "not_delivered";
      if (daysSinceDelivery > windowOf(kind, shop)) return "window_closed";
      if (kind === "return" && order.items.some((item) => item.kind === "commission")) {
        return "commissioned_work";
      }
  }
  if (refundOf(kind, order, remedy) > shop.person_decides_refunds_above_ron) return "large_refund";
  if (filed.has(`${kind} ${order.order_id}`)) return "duplicate";
  return undefined;
}

export function createBackend(world: World, options: { outage?: boolean } = {}): Tools {
  const { shop, orders } = world;
  const filed = new Set<string>();

  const verified = (order_id: string, email: string) => {
    const id = order_id.trim().toUpperCase();
    const address = email.trim().toLowerCase();
    return orders.find((o) => o.order_id === id && o.email.toLowerCase() === address);
  };

  const handlers: Handlers = {
    lookup_order: ({ order_id, email }) => {
      const order = verified(order_id, email);
      return order ? { ok: true, data: order } : NOT_FOUND;
    },
    lookup_account: ({ order_id, email }) => {
      const order = verified(order_id, email);
      if (!order) return NOT_FOUND;
      const mine = orders
        .filter((o) => o.email.toLowerCase() === order.email.toLowerCase())
        .sort((a, b) => a.placed_on.localeCompare(b.placed_on))
        .map(({ order_id, status, placed_on, total_ron }) => ({ order_id, status, placed_on, total_ron }));
      return { ok: true, data: { orders: mine } };
    },
    check_policy: ({ topic, order_id, email }) => {
      const answer = { topic, rule: shop.rules[topic] };
      if (order_id === undefined || email === undefined) return { ok: true, data: answer };
      const order = verified(order_id, email);
      if (!order) return NOT_FOUND;
      const kind = RequestKind.safeParse(topic);
      if (!kind.success) return { ok: true, data: answer };
      const reason = denial(shop, order, kind.data, undefined, filed);
      return {
        ok: true,
        data: { ...answer, decision: reason ? { allowed: false, reason } : { allowed: true } },
      };
    },
    file_request: ({ order_id, email, change }) => {
      const order = verified(order_id, email);
      if (!order) return NOT_FOUND;
      const remedy = change.kind === "damage" ? change.remedy : undefined;
      const reason = denial(shop, order, change.kind, remedy, filed);
      if (reason) {
        return fail({ code: "policy_denied", reason, message: denialMessage(reason, change.kind, shop) });
      }
      filed.add(`${change.kind} ${order.order_id}`);
      return { ok: true, data: { request_id: `R-${filed.size}`, status: "pending_approval" } };
    },
    hand_over: () => ({ ok: true, data: { handover_id: "H-1" } }),
  };

  return {
    async call<K extends ToolName>(name: K, input: unknown) {
      if (options.outage && name !== "hand_over") return UNAVAILABLE;
      const parsed = contracts[name].input.safeParse(input);
      if (!parsed.success) {
        return fail({ code: "invalid_input", message: z.prettifyError(parsed.error) });
      }
      const handle = handlers[name] as (input: unknown) => ToolResult<ToolOutput<K>>;
      return handle(parsed.data);
    },
  };
}
