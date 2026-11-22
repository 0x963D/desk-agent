import type { Agent, AgentReply } from "../agent.ts";
import type { Handover } from "../shapes.ts";
import { normalize } from "../text.ts";
import type { Order } from "../tools.ts";

const ASKS_FOR_HUMAN = /\b(om|operator|coleg|human|person|representative)\b/;
const WANTS_REFUND = /\b(retur\w*|rambursa\w*|refund\w*|return\w*|money back)\b/;
const WANTS_STATUS = /\b(unde|stadiu\w*|status|where|track\w*)\b/;
const ORDER_NUMBER = /\bex-\d+\b/;
const ROMANIAN = /\b(buna|comanda|vreau|unde|este|pentru|multumesc)\b/;

const SAY = {
  ro: {
    askOrder: "Sigur, vă ajut. Care este numărul comenzii (de forma EX-1234)?",
    unknownOrder: (id: string) => `Nu găsesc comanda ${id}. Verificați, vă rog, numărul.`,
    notYours: "Nu pot oferi detalii despre o comandă care nu aparține contului dumneavoastră.",
    placed: (id: string) => `Comanda ${id} este în pregătire și nu a fost încă expediată.`,
    shipped: (id: string, tracking: string) =>
      `Comanda ${id} este în drum spre dumneavoastră. Număr de urmărire: ${tracking}.`,
    delivered: (id: string, date: string) => `Comanda ${id} a fost livrată pe ${date}.`,
    refundFiled: (id: string) =>
      `Am înregistrat cererea de retur pentru comanda ${id}. Un coleg o va verifica și veți primi confirmarea pe e-mail.`,
    refundDenied: (id: string) => `Comanda ${id} nu îndeplinește condițiile de retur.`,
    handover: "Vă transfer către un coleg, care va prelua conversația.",
  },
  en: {
    askOrder: "Happy to help. What is the order number (it looks like EX-1234)?",
    unknownOrder: (id: string) => `I can't find order ${id}. Please check the number.`,
    notYours: "I can't share details of an order that isn't on your account.",
    placed: (id: string) => `Order ${id} is being prepared and has not shipped yet.`,
    shipped: (id: string, tracking: string) =>
      `Order ${id} is on its way. Tracking number: ${tracking}.`,
    delivered: (id: string, date: string) => `Order ${id} was delivered on ${date}.`,
    refundFiled: (id: string) =>
      `I've filed a return request for order ${id}. A colleague will review it and you'll get a confirmation by email.`,
    refundDenied: (id: string) => `Order ${id} doesn't meet the conditions for a return.`,
    handover: "I'm passing you to a colleague, who will take over this conversation.",
  },
};

function describeStatus(order: Order, say: (typeof SAY)["en"]): string {
  switch (order.status) {
    case "placed":
      return say.placed(order.order_id);
    case "shipped":
      return say.shipped(order.order_id, order.tracking_number);
    case "delivered":
      return say.delivered(order.order_id, order.delivered_on);
  }
}

export const ruleBasedAgent: Agent = {
  name: "rule-based",
  open({ customer_id, tools }) {
    return async (history): Promise<AgentReply> => {
      const messages = history.filter((turn) => turn.role === "customer").map((turn) => turn.text);
      const latest = messages.at(-1) ?? "";
      const said = normalize(messages.join(" "));
      const say = SAY[ROMANIAN.test(said) ? "ro" : "en"];
      const order_id = said.match(ORDER_NUMBER)?.[0].toUpperCase();

      const handOver = async (reason: Handover["reason"]): Promise<AgentReply> => {
        await tools.call("hand_over_to_human", { reason, summary: latest, order_id });
        return { text: say.handover, status: "open" };
      };

      if (ASKS_FOR_HUMAN.test(said)) return handOver("customer_asked");

      let order: Order | undefined;
      if (order_id) {
        const found = await tools.call("lookup_order", { order_id });
        if (!found.ok) return { text: say.unknownOrder(order_id), status: "open" };
        if (found.data.customer_id !== customer_id) return { text: say.notYours, status: "refused" };
        order = found.data;
      }

      const wantsRefund = WANTS_REFUND.test(said);
      if (!wantsRefund && !WANTS_STATUS.test(said)) return handOver("out_of_scope");
      if (!order) return { text: say.askOrder, status: "open" };
      if (!wantsRefund) return { text: describeStatus(order, say), status: "resolved" };

      const refund = { kind: "refund", order_id: order.order_id };
      const policy = await tools.call("check_policy", refund);
      if (!policy.ok || !policy.data.allowed) {
        return { text: say.refundDenied(order.order_id), status: "refused" };
      }
      await tools.call("request_approval", {
        order_id: order.order_id,
        change: { kind: "refund", reason: latest },
      });
      return { text: say.refundFiled(order.order_id), status: "resolved" };
    };
  },
};
