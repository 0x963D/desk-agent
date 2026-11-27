import { contracts, type ToolInput } from "./tools.ts";
import { amended, type AgentTurn, type Change, type ObservedOutcome, type ToolCall, type ToolError, type ToolName, type Turn } from "./shapes.ts";

export const agentTurns = (turns: readonly Turn[]): AgentTurn[] =>
  turns.filter((turn) => turn.role === "agent");

const calls = <N extends ToolName>(turns: readonly Turn[], ...names: N[]) =>
  agentTurns(turns)
    .flatMap((turn) => turn.tool_calls)
    .filter((call): call is ToolCall & { name: N } => (names as ToolName[]).includes(call.name));

// A request on file when the conversation ends, with the changes it held before, the filed one first.
export type OnFile = ToolInput<"file_request"> & { earlier: Change[] };

// The requests on file when the conversation ends: each accepted file_request, with every accepted
// amend_request applied to the request it names, in the order they were filed.
export function filedRequests(turns: readonly Turn[]): OnFile[] {
  const onFile = new Map<string, OnFile>();
  for (const call of calls(turns, "file_request", "amend_request")) {
    if (!call.output.ok) continue;
    if (call.name === "file_request") {
      const { request_id } = contracts.file_request.output.parse(call.output.data);
      onFile.set(request_id, { ...contracts.file_request.input.parse(call.input), earlier: [] });
      continue;
    }
    const { request_id } = contracts.amend_request.output.parse(call.output.data);
    const filed = onFile.get(request_id);
    if (!filed) throw new Error(`the trace amends ${request_id}, which no accepted file_request returned`);
    const { change } = contracts.amend_request.input.parse(call.input);
    onFile.set(request_id, { ...filed, change: amended(filed.change, change), earlier: [...filed.earlier, filed.change] });
  }
  return [...onFile.values()];
}

export function handoverOf(turns: readonly Turn[]): ToolInput<"hand_over"> | undefined {
  const first = calls(turns, "hand_over").find((call) => call.output.ok);
  return first && contracts.hand_over.input.parse(first.input);
}

const BLOCKING: ReadonlySet<ToolError["code"]> = new Set(["policy_denied", "not_found"]);

// A filing or an amendment that the function refused because the policy forbids it or the customer
// is not verified.
export const blockedAttempts = (turns: readonly Turn[]): string[] =>
  calls(turns, "file_request", "amend_request").flatMap((call) => {
    if (call.output.ok || !BLOCKING.has(call.output.error.code)) return [];
    const { error } = call.output;
    const input = contracts[call.name].input.safeParse(call.input);
    const amend = call.name === "amend_request" ? " amendment" : "";
    const what = input.success ? `${input.data.change.kind}${amend} for ${input.data.order_id}` : `a request${amend}`;
    return [`${what}: ${error.code === "policy_denied" ? error.reason : error.code}`];
  });

export function outcomeOf(turns: readonly Turn[]): ObservedOutcome {
  if (handoverOf(turns)) return "handed_over";
  const status = agentTurns(turns).at(-1)?.status ?? "open";
  return status === "open" ? "unfinished" : status;
}
