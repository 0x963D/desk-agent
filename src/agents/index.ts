import type { Agent } from "../agent.ts";
import { ruleBasedAgent } from "./rule-based.ts";

export const agents: Readonly<Record<string, Agent>> = {
  [ruleBasedAgent.name]: ruleBasedAgent,
};

export const DEFAULT_AGENT = ruleBasedAgent.name;
