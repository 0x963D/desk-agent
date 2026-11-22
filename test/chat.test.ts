import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Agent } from "../src/agent.ts";
import { agents } from "../src/agents/index.ts";
import { chat, type ChatOutput, type ChatSource } from "../src/chat.ts";
import { main, type Terminal } from "../src/cli.ts";
import { readJson } from "../src/files.ts";
import { grade, passed } from "../src/grade.ts";
import { redacted } from "../src/redact.ts";
import { ChatLog, Conversation } from "../src/shapes.ts";
import { caseExpecting, ROOT, tempDir, testRepo } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

function recorder() {
  const conversation: string[] = [];
  const notes: string[] = [];
  const output: ChatOutput = { conversation: (line) => conversation.push(line), note: (line) => notes.push(line) };
  return { output, conversation, notes };
}

async function* typed(...lines: string[]) {
  yield* lines;
}

const live = (...lines: string[]): ChatSource => ({ mode: "live", lines: typed(...lines), echo: true });

async function onlyLog(root: string, agent: string): Promise<{ text: string; log: ChatLog }> {
  const dir = join(root, "traces", "chat", agent);
  const [name, ...more] = await readdir(dir);
  if (!name || more.length > 0) throw new Error(`expected one session log in ${dir}`);
  const file = join(dir, name);
  return { text: await readFile(file, "utf8"), log: await readJson(file, ChatLog) };
}

// Personal data of every kind, as a customer types it and as a function returns it.
const TYPED = {
  email: "jonas.weber@example.com",
  phone: "0722 123 456",
  card: "4111 1111 1111 1111",
  iban: "RO49 AAAA 1B31 0075 9384 0000",
  address: "Str. Vulpii Argintii 12",
};
const RETURNED = {
  address: "Beispielweg 4",
  phone: "0733 987 654",
  card: "5500 0000 0000 0004",
  iban: "DE89 3704 0044 0532 0130 00",
  street: "7 Paper Heron Row",
};
const PERSONAL = [...Object.values(TYPED), ...Object.values(RETURNED)].flatMap((value) => [value, value.replaceAll(" ", "")]);

async function repoWithGiftNote(): Promise<string> {
  const root = await testRepo();
  const file = join(root, "fixtures", "tuning.yaml");
  const fixtures = parseYaml(await readFile(file, "utf8")) as { orders: { order_id: string; gift_note?: string }[] };
  const order = fixtures.orders.find((o) => o.order_id === "SC-1003")!;
  order.gift_note = `Suna-ma la ${RETURNED.phone}, platesc cu ${RETURNED.card}, IBAN ${RETURNED.iban}, sau lasa-l la ${RETURNED.street}.`;
  await writeFile(file, stringifyYaml(fixtures));
  return root;
}

// Looks up the order with the email the customer typed, then asks for a delivery change to the
// address the customer typed, which the shop refuses because the order has shipped. It keeps each message it was handed, to show what the model sees.
const seenByAgent: string[] = [];
const careful: Agent = {
  name: "careful",
  open: ({ tools }) => {
    let turn = 0;
    return async (history) => {
      seenByAgent.push(history.at(-1)!.text);
      if (turn++ === 0) {
        const found = await tools.call("lookup_order", { order_id: "SC-1003", email: TYPED.email });
        return { text: found.ok ? `Found SC-1003, placed on ${found.data.placed_on}.` : "Not found.", status: "open" };
      }
      const filed = await tools.call("file_request", {
        order_id: "SC-1003",
        email: TYPED.email,
        change: { kind: "delivery_change", new_address: `${TYPED.address}, Oradea` },
      });
      return { text: filed.ok ? "Filed for staff approval." : "Could not file it.", status: "resolved" };
    };
  },
};

test("personal data a customer typed or a function returned never reaches the session log or a note", async () => {
  const root = await repoWithGiftNote();
  const { output, conversation, notes } = recorder();
  const first = `Comanda SC-1003 din 2026-11-02, 150 lei. Mailul ${TYPED.email}, telefon ${TYPED.phone}, card ${TYPED.card}, IBAN ${TYPED.iban}.`;
  const second = `Adresa noua e ${TYPED.address}, Oradea.`;

  await chat(root, careful, live(first, second), output);

  const { text, log } = await onlyLog(root, "careful");
  for (const value of PERSONAL) {
    expect(text).not.toContain(value);
    for (const line of notes) expect(line).not.toContain(value);
  }
  for (const kept of ["SC-1003", "2026-11-02", "150 lei", "2026-11-10", "\"status\": \"shipped\"", "already_shipped"]) {
    expect(text).toContain(kept);
  }
  expect(notes.join("\n")).toContain("SC-1003");
  expect(notes.join("\n")).toContain("2026-11-10");
  expect(text).toContain('"total_ron": 150');
  expect(log.turns.filter((turn) => turn.role === "agent").map((turn) => turn.tool_calls[0]?.output.ok)).toEqual([true, false]);

  expect(seenByAgent).toEqual([first, second]);
  expect(conversation.join("\n")).toContain(TYPED.card);
});

test("a replay plays a tuning case's committed recording offline, through the agent the scored runs use", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const root = await tempDir();
  const id = "ro-unde-e-coletul";
  await cp(join(ROOT, "fixtures"), join(root, "fixtures"), { recursive: true, filter: (path) => !path.includes("held-out") });
  await cp(join(ROOT, "cases", "tuning"), join(root, "cases", "tuning"), { recursive: true });
  await mkdir(join(root, "recordings", "plain-gpt-6-luna", "tuning"), { recursive: true });
  await cp(
    join(ROOT, "recordings", "plain-gpt-6-luna", "tuning", `${id}.json`),
    join(root, "recordings", "plain-gpt-6-luna", "tuning", `${id}.json`),
  );
  const { output, conversation, notes } = recorder();

  const closing = await chat(root, agents.get("plain-gpt-6-luna")!, { mode: "replay", case_id: id }, output);

  const { log } = await onlyLog(root, "plain-gpt-6-luna");
  expect(log.replay_of).toBe(id);
  expect(conversation.filter((line) => line.startsWith("agent"))).toHaveLength(
    log.turns.filter((turn) => turn.role === "agent").length,
  );
  expect(notes[0]).toContain("Offline: no model call is made and nothing is spent.");
  expect(notes.some((line) => line.startsWith("  · lookup_order"))).toBe(true);
  expect(closing).toContain("This replay spent nothing.");
});

test("a live chat with a model agent does not start without the provider key", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const { output, conversation, notes } = recorder();

  const started = chat(await testRepo(), agents.get("plain-gpt-6-luna")!, live("salut"), output);

  await expect(started).rejects.toThrow("OPENAI_API_KEY is not set");
  expect([...conversation, ...notes]).toEqual([]);
});

test("a live chat states the cap and counts its spend in the same file as recording, which stops it at the cap", async () => {
  vi.stubEnv("SPEND_CAP_USD", "0.015");
  const root = await testRepo();
  const paid: Agent = {
    name: "paid",
    liveModel: () => ({ complete: async () => ({ response: "Bună ziua!", cost_usd: 0.01 }) }),
    open: ({ model }) => async () => ({ text: String((await model.complete({})).response), status: "resolved" }),
  };
  const { output, conversation, notes } = recorder();

  const stopped = chat(root, paid, live("unu", "doi", "trei"), output);

  await expect(stopped).rejects.toThrow("has reached the cap set by SPEND_CAP_USD");
  expect(notes[0]).toContain("The spend cap is $0.0150 (SPEND_CAP_USD), and $0.0000 is spent so far in .artifacts/spend.json");
  expect(conversation.filter((line) => line.startsWith("agent"))).toHaveLength(2);
  expect(JSON.parse(await readFile(join(root, ".artifacts", "spend.json"), "utf8"))).toEqual({ spent_usd: 0.02 });
  expect((await onlyLog(root, "paid")).log.turns).toHaveLength(4);
});

test("chat ends when the agent hands over, and the CLI echoes piped customer lines", async () => {
  const root = await testRepo();
  const { output, conversation, notes } = recorder();
  const terminal: Terminal = { interactive: false, lines: () => typed("I want to talk to a person", "hello?"), output };

  const closing = await main(["chat", "--agent", "rule-based"], root, terminal);

  expect(conversation[0]).toBe("customer  I want to talk to a person");
  expect(conversation.filter((line) => line.startsWith("customer"))).toHaveLength(1);
  expect(notes).toContain("The agent handed the conversation to a person, who owns it from here, so the chat ends.");
  expect(closing).toMatch(/^The session log, with personal data masked, is traces\/chat\/rule-based\/.+\.json\. This chat spent nothing\.$/);
});

test("chat refuses a case that is not a tuning case and options it does not take", async () => {
  const root = await testRepo();

  await expect(main(["chat", "--replay", "en-cancel-paid-order"], root)).rejects.toThrow(
    "no tuning case is named en-cancel-paid-order",
  );
  await expect(main(["chat", "--record"], root)).rejects.toThrow("usage:");
  await expect(main(["chat", "--markdown"], root)).rejects.toThrow("usage:");
});

test("a scored trace stays exact and grades the same after a chat replays its case", async () => {
  const root = await testRepo();
  const tuned = await main(["tune"], root);
  const [run] = await readdir(join(root, "traces", "rule-based"));
  const file = join(root, "traces", "rule-based", run!, "conversations", "en-where-is-my-order.json");
  const saved = await readFile(file, "utf8");

  await chat(root, agents.get("rule-based")!, { mode: "replay", case_id: "en-where-is-my-order" }, recorder().output);

  expect(await readFile(file, "utf8")).toBe(saved);
  expect(saved).toContain("jonas.weber@example.com");
  expect(await main(["regrade", join(root, "traces", "rule-based", run!)], root)).toBe(tuned);
  expect((await onlyLog(root, "rule-based")).text).not.toContain("jonas.weber@example.com");
});

test("a redacted trace would hide a leak from the grader, so scored traces are never redacted", async () => {
  const leak = caseExpecting({ outcome: "resolved", reply_never_mentions: ["jonas.weber@example.com"] });
  const conversation = Conversation.parse({
    conversation_id: "c",
    case_id: leak.id,
    split: "tuning",
    agent: "leaky",
    turns: [
      { role: "customer", text: "Hello" },
      { role: "agent", text: "The order is on jonas.weber@example.com.", status: "resolved", tool_calls: [], duration_ms: 1, cost_usd: 0 },
    ],
  });

  expect(passed(grade(leak, conversation))).toBe(false);
  expect(passed(grade(leak, redacted(conversation)))).toBe(true);
});
