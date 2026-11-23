import type { Agent } from "../agent.ts";
import { plainAgent } from "./plain.ts";
import { SECOND_VENDOR_PROMPT } from "./prompt.ts";
import { ruleBasedAgent } from "./rule-based.ts";
import { sdkAgent } from "./sdk.ts";

export const agents: ReadonlyMap<string, Agent> = new Map(
  [
    ruleBasedAgent,
    plainAgent("gpt-6-luna", "low"),
    plainAgent("gpt-6.2-sol", "low"),
    sdkAgent({ provider: "openai", model: "gpt-6-luna" }),
    sdkAgent({ provider: "openai", model: "gpt-6.2-sol" }),
    sdkAgent({ provider: "anthropic", model: "claude-haiku-5-5" }),
    sdkAgent({ provider: "anthropic", model: "claude-sonnet-5-5" }),
    sdkAgent({ provider: "anthropic", model: "claude-haiku-5-5", prompt: SECOND_VENDOR_PROMPT }),
    sdkAgent({ provider: "anthropic", model: "claude-sonnet-5-5", prompt: SECOND_VENDOR_PROMPT }),
  ].map((agent) => [agent.name, agent]),
);

export const DEFAULT_AGENT = ruleBasedAgent.name;
