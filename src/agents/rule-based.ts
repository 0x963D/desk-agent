import type { Agent, AgentReply } from "../agent.ts";
import type { Handover, Order, ToolError } from "../shapes.ts";
import { normalize } from "../text.ts";

const ASKS_FOR_PERSON = /\b(om|operator|persoana|coleg|human|person|someone)\b/;
const COMMISSION = /\b(tatuaj\w*|tattoo\w*|comision\w*|commission\w*|programare)\b/;
const CANCEL = /\b(anul\w*|cancel\w*)\b/;
const RETURN = /\b(retur\w*|return\w*|refund\w*|rambursa\w*)\b/;
const STATUS = /\b(unde|cand|status|stadiu\w*|where|when|track\w*)\b/;
const ORDER_NUMBER = /\bam-\d{4}\b/;
const EMAIL = /[^\s@,;:]+@[^\s@,;:]+\.[a-z]{2,}/;
const ROMANIAN = /\b(buna|comanda|vreau|unde|cand|este|pentru|multumesc|emailul|sa)\b/;

const SAY = {
  ro: {
    askDetails: "Vă ajut cu plăcere. Îmi spuneți numărul comenzii (AM-1234) și adresa de email folosită la comandă?",
    notFound: "Nu găsesc nicio comandă cu acest număr și acest email, așa că nu pot da detalii.",
    paid: (id: string) => `Comanda ${id} este plătită și intră curând în producție.`,
    inProduction: (id: string) => `Comanda ${id} este în producție.`,
    shipped: (id: string, url: string) => `Comanda ${id} a fost expediată. O puteți urmări aici: ${url}`,
    delivered: (id: string, date: string) => `Comanda ${id} a fost livrată pe ${date}.`,
    filed: (id: string) =>
      `Am înregistrat cererea pentru comanda ${id}. Echipa trebuie să o aprobe și vă scrie pe email.`,
    denied: (message: string) => `Nu pot înregistra cererea: ${message}`,
    handover: "Vă transfer către un coleg, care preia conversația.",
  },
  en: {
    askDetails: "Happy to help. What is your order number (AM-1234) and the email you ordered with?",
    notFound: "I can't find an order with that number and email, so I can't share any details.",
    paid: (id: string) => `Order ${id} is paid and goes into production soon.`,
    inProduction: (id: string) => `Order ${id} is in production.`,
    shipped: (id: string, url: string) => `Order ${id} has shipped. You can track it here: ${url}`,
    delivered: (id: string, date: string) => `Order ${id} was delivered on ${date}.`,
    filed: (id: string) =>
      `I've filed the request for order ${id}. Staff must approve it, and they will email you.`,
    denied: (message: string) => `I can't file that request: ${message}`,
    handover: "I'm passing you to a colleague, who will take over this conversation.",
  },
};

function describe(order: Order, say: (typeof SAY)["en"]): string {
  switch (order.status) {
    case "paid":
      return say.paid(order.order_id);
    case "in_production":
      return say.inProduction(order.order_id);
    case "shipped":
      return say.shipped(order.order_id, order.tracking_url);
    case "delivered":
      return say.delivered(order.order_id, order.delivered_on);
  }
}

export const ruleBasedAgent: Agent = {
  name: "rule-based",
  open({ tools }) {
    return async (history): Promise<AgentReply> => {
      const messages = history.filter((turn) => turn.role === "customer").map((turn) => turn.text);
      const said = normalize(messages.join(" "));
      const say = SAY[ROMANIAN.test(said) ? "ro" : "en"];
      const order_id = said.match(ORDER_NUMBER)?.[0].toUpperCase();
      const email = said.match(EMAIL)?.[0];

      const handOver = async (reason: Handover["reason"]): Promise<AgentReply> => {
        await tools.call("hand_over", { reason, summary: messages.join("\n"), order_id });
        return { text: say.handover, status: "open" };
      };
      const onError = (error: ToolError): Promise<AgentReply> | AgentReply => {
        if (error.code === "unavailable") return handOver("system_failure");
        if (error.code === "policy_denied" && error.reason === "large_refund") {
          return handOver("staff_decision");
        }
        if (error.code === "policy_denied") return { text: say.denied(error.message), status: "refused" };
        return { text: say.notFound, status: "refused" };
      };

      if (ASKS_FOR_PERSON.test(said)) return handOver("customer_asked");
      if (COMMISSION.test(said)) return handOver("commission_or_booking");
      const kind = CANCEL.test(said) ? "cancellation" : RETURN.test(said) ? "return" : undefined;
      if (!kind && !STATUS.test(said)) return handOver("staff_decision");
      if (!order_id || !email) return { text: say.askDetails, status: "open" };

      if (!kind) {
        const found = await tools.call("lookup_order", { order_id, email });
        return found.ok ? { text: describe(found.data, say), status: "resolved" } : onError(found.error);
      }
      const filed = await tools.call("file_request", { order_id, email, change: { kind } });
      return filed.ok ? { text: say.filed(order_id), status: "resolved" } : onError(filed.error);
    };
  },
};
