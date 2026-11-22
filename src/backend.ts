import { z } from "zod";
import type { ApprovalRequest, Handover, ToolName } from "./shapes.ts";
import {
  Account,
  contracts,
  Order,
  type ToolInput,
  type ToolOutput,
  type ToolResult,
  type Tools,
} from "./tools.ts";

export const Fixtures = z.strictObject({
  today: z.iso.date(),
  refund_window_days: z.number().int().positive(),
  customers: z.array(Account),
  orders: z.array(Order),
});
export type Fixtures = z.infer<typeof Fixtures>;

type Handlers = { [K in ToolName]: (input: ToolInput<K>) => ToolResult<ToolOutput<K>> };

const DAY_MS = 86_400_000;
const NOT_FOUND = { ok: false, error: "not_found" } as const;

const found = <T>(data: T | undefined): ToolResult<T> =>
  data === undefined ? NOT_FOUND : { ok: true, data };

export function createBackend(fixtures: Fixtures) {
  const requests: ApprovalRequest[] = [];
  let handover: Handover | null = null;

  const order = (id: string) => fixtures.orders.find((o) => o.order_id === id);

  const policy = (kind: ToolInput<"check_policy">["kind"], o: Order): ToolOutput<"check_policy"> => {
    if (kind === "delivery_change") {
      return o.status === "placed"
        ? { allowed: true, reason: "not_shipped_yet" }
        : { allowed: false, reason: "already_shipped" };
    }
    if (o.status !== "delivered") return { allowed: false, reason: "not_delivered_yet" };
    const days = (Date.parse(fixtures.today) - Date.parse(o.delivered_on)) / DAY_MS;
    return days <= fixtures.refund_window_days
      ? { allowed: true, reason: "within_return_window" }
      : { allowed: false, reason: "outside_return_window" };
  };

  const handlers: Handlers = {
    lookup_order: ({ order_id }) => found(order(order_id)),
    lookup_account: ({ customer_id }) =>
      found(fixtures.customers.find((c) => c.customer_id === customer_id)),
    check_policy: ({ kind, order_id }) => {
      const o = order(order_id);
      return o ? { ok: true, data: policy(kind, o) } : NOT_FOUND;
    },
    request_approval: (request) => {
      if (!order(request.order_id)) return NOT_FOUND;
      requests.push(request);
      return { ok: true, data: { request_id: `R-${requests.length}`, status: "pending_approval" } };
    },
    hand_over_to_human: (input) => {
      handover ??= input;
      return { ok: true, data: { handover_id: "H-1" } };
    },
  };

  const tools: Tools = {
    async call<K extends ToolName>(name: K, input: unknown) {
      const parsed = contracts[name].input.safeParse(input);
      if (!parsed.success) return { ok: false, error: "invalid_input" } as const;
      const handle = handlers[name] as (input: unknown) => ToolResult<ToolOutput<K>>;
      return handle(parsed.data);
    },
  };

  return { tools, state: () => ({ requests: [...requests], handover }) };
}
