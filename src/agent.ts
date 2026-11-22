import type { LiveModel, ModelClient } from "./model.ts";
import type { AgentTurn, Turn } from "./shapes.ts";
import type { Tools } from "./tools.ts";

export type AgentReply = {
  text: string;
  status: AgentTurn["status"];
};

export type Respond = (history: readonly Turn[]) => Promise<AgentReply>;

export type Agent = {
  name: string;
  liveModel?: () => LiveModel;
  open(conversation: {
    conversation_id: string;
    tools: Tools;
    model: ModelClient;
  }): Respond | Promise<Respond>;
};
