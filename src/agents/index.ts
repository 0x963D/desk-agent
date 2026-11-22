import type { Agent } from "../agent.ts";
import { plainAgent } from "./plain.ts";
import { ruleBasedAgent } from "./rule-based.ts";

export const agents: ReadonlyMap<string, Agent> = new Map(
  [ruleBasedAgent, plainAgent("gpt-6-luna", "low"), plainAgent("gpt-6.2-sol", "low")].map((agent) => [agent.name, agent]),
);

export const DEFAULT_AGENT = ruleBasedAgent.name;
