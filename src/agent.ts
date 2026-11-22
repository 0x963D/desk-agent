import type { ModelClient } from "./model.ts";
import type { AgentTurn, Turn } from "./shapes.ts";
import type { Tools } from "./tools.ts";

export type Usage = { duration_ms: number; cost_usd: number };

export type AgentReply = {
  text: string;
  status: AgentTurn["status"];
  usage?: Usage;
};

export type Respond = (history: readonly Turn[]) => Promise<AgentReply>;

export type Agent = {
  name: string;
  open(conversation: {
    conversation_id: string;
    tools: Tools;
    model: ModelClient;
  }): Respond | Promise<Respond>;
};
