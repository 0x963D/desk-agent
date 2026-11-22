import { contracts, type ToolInput } from "./tools.ts";
import type { AgentTurn, ObservedOutcome, ToolError, Turn } from "./shapes.ts";

export const agentTurns = (turns: readonly Turn[]): AgentTurn[] =>
  turns.filter((turn) => turn.role === "agent");

const calls = (turns: readonly Turn[], name: "file_request" | "hand_over") =>
  agentTurns(turns)
    .flatMap((turn) => turn.tool_calls)
    .filter((call) => call.name === name);

export const filedRequests = (turns: readonly Turn[]): ToolInput<"file_request">[] =>
  calls(turns, "file_request")
    .filter((call) => call.output.ok)
    .map((call) => contracts.file_request.input.parse(call.input));

export function handoverOf(turns: readonly Turn[]): ToolInput<"hand_over"> | undefined {
  const first = calls(turns, "hand_over").find((call) => call.output.ok);
  return first && contracts.hand_over.input.parse(first.input);
}

const BLOCKING: ReadonlySet<ToolError["code"]> = new Set(["policy_denied", "not_found"]);

export const blockedAttempts = (turns: readonly Turn[]): string[] =>
  calls(turns, "file_request").flatMap((call) => {
    if (call.output.ok || !BLOCKING.has(call.output.error.code)) return [];
    const { error } = call.output;
    const input = contracts.file_request.input.safeParse(call.input);
    const what = input.success ? `${input.data.change.kind} for ${input.data.order_id}` : "a request";
    return [`${what}: ${error.code === "policy_denied" ? error.reason : error.code}`];
  });

export function outcomeOf(turns: readonly Turn[]): ObservedOutcome {
  if (handoverOf(turns)) return "handed_over";
  const status = agentTurns(turns).at(-1)?.status ?? "open";
  return status === "open" ? "unfinished" : status;
}
