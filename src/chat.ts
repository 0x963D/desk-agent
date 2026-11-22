import { join, relative } from "node:path";
import type { Agent } from "./agent.ts";
import { createBackend } from "./backend.ts";
import { loadSplit, runName, writeJson } from "./files.ts";
import { guardedModel, recordedModel, recordingPath, type ModelClient } from "./model.ts";
import { redact, redacted } from "./redact.ts";
import { openSession } from "./runner.ts";
import { ChatLog, type ToolCall } from "./shapes.ts";
import { spendCap, spendFile, spendGuard } from "./spend.ts";
import { dollars, milliseconds } from "./summary.ts";

// Where the customer's messages come from: a person typing, or a tuning case and its recording.
export type ChatSource =
  | { mode: "live"; lines: AsyncIterable<string>; echo: boolean }
  | { mode: "replay"; case_id: string };

// The terminal. `conversation` shows what the customer and the agent said, as they said it.
// `note` shows everything else, and chat passes every note through `redact` first.
export type ChatOutput = { conversation(line: string): void; note(line: string): void };

const RESULT_CHARS = 200;

const shown = (root: string, path: string) => relative(root, path).replaceAll("\\", "/");

function callLine(call: ToolCall): string {
  const { name, input, output } = redacted(call);
  const result = output.ok
    ? `ok ${JSON.stringify(output.data)}`
    : `${output.error.code}${output.error.code === "policy_denied" ? ` (${output.error.reason})` : ""}`;
  const line = `  · ${name} ${JSON.stringify(input)} → ${result}`;
  return line.length > RESULT_CHARS ? `${line.slice(0, RESULT_CHARS - 1)}…` : line;
}

const indented = (who: string, text: string) =>
  text
    .split("\n")
    .map((line, at) => `${(at === 0 ? who : "").padEnd(10)}${line}`)
    .join("\n");

export async function chat(root: string, agent: Agent, source: ChatSource, out: ChatOutput): Promise<string> {
  const note = (line: string) => out.note(redact(line));
  const { shop, cases, orders } = await loadSplit(root, "tuning");

  let model: ModelClient | undefined;
  let customer: AsyncIterable<string> | Iterable<string>;
  let echo = true;
  let outage = false;
  let closing: () => Promise<string>;
  if (source.mode === "replay") {
    const testCase = cases.find((c) => c.id === source.case_id);
    if (!testCase) {
      throw new Error(`no tuning case is named ${source.case_id}. Tuning cases: ${cases.map((c) => c.id).join(", ")}`);
    }
    const file = recordingPath(root, agent.name, "tuning", testCase.id);
    model = recordedModel(file);
    customer = testCase.turns;
    outage = testCase.outage;
    note(
      agent.liveModel
        ? `Replaying tuning case ${testCase.id} for ${agent.name} from ${shown(root, file)}. Offline: no model call is made and nothing is spent.`
        : `Playing tuning case ${testCase.id} for ${agent.name}, which makes no model call.`,
    );
    closing = async () =>
      agent.liveModel ? "This replay spent nothing. Each turn shows what its recorded calls cost." : "This replay spent nothing.";
  } else {
    // Built first, so a missing key stops the chat before it prints or spends anything.
    const live = agent.liveModel?.();
    customer = source.lines;
    echo = source.echo;
    if (live) {
      const cap = spendCap();
      const guard = spendGuard(spendFile(root), cap);
      const before = await guard.spent();
      model = guardedModel(live, guard);
      note(
        `Live chat with ${agent.name} on the ${orders.length} tuning orders. Every reply calls a paid model. The spend cap is ${dollars(cap)} (SPEND_CAP_USD), and ${dollars(before)} is spent so far in ${shown(root, spendFile(root))}, by recordings and chats together.`,
      );
      closing = async () => {
        const after = await guard.spent();
        return `This chat spent ${dollars(after - before)}. ${dollars(after)} of the ${dollars(cap)} cap is now spent.`;
      };
    } else {
      note(`Chat with ${agent.name} on the ${orders.length} tuning orders. It makes no model call, so it costs nothing.`);
      closing = async () => "This chat spent nothing.";
    }
    note("Write as the customer. An empty line is skipped. End the input to finish.");
  }

  const session = await openSession(agent, createBackend({ shop, orders }, { outage }), model && { model });
  const file = join(root, "traces", "chat", agent.name, `${runName()}.json`);
  const started_at = new Date().toISOString();
  const save = () =>
    writeJson(file, ChatLog, {
      conversation_id: session.conversation_id,
      agent: agent.name,
      orders: "tuning",
      ...(source.mode === "replay" && { replay_of: source.case_id }),
      started_at,
      turns: redacted([...session.turns]),
    });

  try {
    for await (const typed of customer) {
      const text = typed.trim();
      if (text === "") continue;
      if (echo) out.conversation(indented("customer", text));
      const turn = await session.say(text);
      await save();
      for (const call of turn.tool_calls) note(callLine(call));
      out.conversation(indented("agent", turn.text));
      note(`  [${turn.status} · ${milliseconds(turn.duration_ms)} · ${dollars(turn.cost_usd)}]`);
      if (session.handedOver()) {
        note("The agent handed the conversation to a person, who owns it from here, so the chat ends.");
        break;
      }
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`the chat stopped: ${why}`), { cause: error });
  } finally {
    await session.close();
  }

  const saved =
    session.turns.length > 0
      ? `The session log, with personal data masked, is ${shown(root, file)}.`
      : "No message was written, so no session log was saved.";
  return redact(`${saved} ${await closing()}`);
}
