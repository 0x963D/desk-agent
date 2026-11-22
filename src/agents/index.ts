import type { Agent } from "../agent.ts";
import { ruleBasedAgent } from "./rule-based.ts";

export const agents: ReadonlyMap<string, Agent> = new Map([ruleBasedAgent].map((agent) => [agent.name, agent]));

export const DEFAULT_AGENT = ruleBasedAgent.name;
