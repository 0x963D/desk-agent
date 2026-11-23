import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { parseVerdicts } from "../src/agreement.ts";
import { main } from "../src/cli.ts";
import { readJson } from "../src/files.ts";
import { buildPacket, renderConversation, type Source } from "../src/packet.ts";
import { AuditKey, Conversation, Criterion, type Turn } from "../src/shapes.ts";
import { parseConversation, type ShownTurn } from "../src/sheet.ts";
import { ROOT, tempDir } from "./helpers.ts";

const HANDED_OVER: Turn[] = [
  { role: "customer", text: "Bună ziua, comanda SC-2001 a plecat spre Brașov?\n\nEmailul e ana@example.com." },
  {
    role: "agent",
    text: "Sistemul nu răspunde acum.\nUn coleg preia conversația.",
    status: "open",
    tool_calls: [
      {
        name: "lookup_order",
        input: { order_id: "SC-2001", email: "ana@example.com" },
        output: { ok: false, error: { code: "unavailable", message: "The shop system is not answering." } },
      },
      {
        name: "hand_over",
        input: { reason: "system_failure", summary: "Tracking for SC-2001 during an outage.", order_id: "SC-2001" },
        output: { ok: true, data: { handover_id: "H-1" } },
      },
    ],
    duration_ms: 812.5,
    cost_usd: 0.0151,
  },
];

const RESOLVED: Turn[] = [
  { role: "customer", text: "How long does printing take?" },
  {
    role: "agent",
    text: "Production takes 3 to 5 working days.",
    status: "resolved",
    tool_calls: [{ name: "check_policy", input: { topic: "production" }, output: { ok: true, data: { rule: "3 to 5 working days." } } }],
    duration_ms: 431.25,
    cost_usd: 0.0042,
  },
  { role: "customer", text: "Mersi!" },
  { role: "agent", text: "Cu plăcere!", status: "resolved", tool_calls: [], duration_ms: 120.75, cost_usd: 0.0009 },
];

const UNPLAYED = ["Și dacă nu ajunge până vineri?\n\nE un cadou.", "Mersi."];

const shown = (turns: readonly Turn[]): ShownTurn[] =>
  turns.map((turn, at) =>
    turn.role === "customer"
      ? { number: at + 1, role: "customer", text: turn.text }
      : { number: at + 1, role: "agent", calls: turn.tool_calls, reply: turn.text },
  );

test("a packet file reads back as the turns, the function calls and the handover it shows", () => {
  expect(parseConversation(renderConversation("c0ffee01", HANDED_OVER, UNPLAYED), "x.md")).toEqual({
    id: "c0ffee01",
    turns: shown(HANDED_OVER),
    handover: { turn: 2, reason: "system_failure", order: "SC-2001", summary: "Tracking for SC-2001 during an outage." },
    unplayed: [
      { message: 2, of: 3, text: UNPLAYED[0] },
      { message: 3, of: 3, text: UNPLAYED[1] },
    ],
  });
  expect(parseConversation(renderConversation("c0ffee02", RESOLVED, []), "x.md")).toEqual({
    id: "c0ffee02",
    turns: shown(RESOLVED),
    handover: undefined,
    unplayed: [],
  });
  expect(() => parseConversation("# Conversation x\n\n## Turn 1, customer\n\nno quote\n", "x.md")).toThrow(
    /x\.md block 3: expected a quoted text/,
  );
});

function source(agent: string, case_id: string, turns: Turn[], unplayed: string[] = []): Source {
  const conversation = Conversation.parse({ conversation_id: `uuid-of-${case_id}-${agent}`, case_id, split: "held-out", agent, turns });
  return { agent, run: `results/${agent}/run-1`, conversation, unplayed };
}

const SOURCES = [
  source("agent-alpha", "ro-secret-case", HANDED_OVER, UNPLAYED),
  source("agent-alpha", "en-alt-case", RESOLVED),
  source("agent-beta", "ro-secret-case", HANDED_OVER, UNPLAYED),
  source("agent-beta", "en-alt-case", RESOLVED),
];

const HIDDEN_NOTE = "Another reader's note that the sheet must not show.";

async function packetDir() {
  const work = await tempDir();
  const docs = {
    scope: await readFile(join(ROOT, "docs", "scope.md"), "utf8"),
    judging: await readFile(join(ROOT, "docs", "judging.md"), "utf8"),
  };
  const { key, files } = buildPacket(SOURCES, "seed", docs);
  for (const [path, text] of files) {
    await mkdir(join(work, "packet", path, ".."), { recursive: true });
    await writeFile(join(work, "packet", path), text);
  }
  const ids = key.conversations.map((c) => c.id);
  await writeFile(
    join(work, "packet", "verdicts.jsonl"),
    ids.map((id) => JSON.stringify({ id, acceptable: false, ...Object.fromEntries(Criterion.options.map((c) => [c, c !== "facts"])), note: `Turn 2: ${HIDDEN_NOTE}` })).join("\n"),
  );
  const cut = new Set(key.conversations.filter((c) => c.case_id === "ro-secret-case").map((c) => c.id));
  return { work, packet: join(work, "packet"), ids, cut };
}

test("the sheet shows every listed conversation in the given order, and nothing that names its source or another verdict", async () => {
  const { work, packet, ids, cut } = await packetDir();
  const listed = [ids[2]!, ids[0]!, ids[3]!];
  await writeFile(join(work, "ids.txt"), `${listed.join("\n")}\n`);
  const out = join(work, "sheet.html");

  const printed = await main(["audit-sheet", "--packet", packet, "--ids", join(work, "ids.txt"), "--out", out], ROOT);
  const html = await readFile(out, "utf8");

  expect(printed).toContain("sheet: 3 conversations");
  const order = [...html.matchAll(/<section class="conversation" data-id="([0-9a-f]+)"/g)].map((match) => match[1]);
  expect(order).toEqual(listed);
  expect(html).not.toContain(`data-id="${ids[1]}"`);
  expect(html).toContain("Conversation 3 of 3");
  expect(html).toContain("Bună ziua, comanda SC-2001 a plecat spre Brașov?\n\nEmailul e ana@example.com.");
  expect(html).toContain("Cu plăcere!");
  expect(html).toMatch(/<details class="call"><summary>Function call 1: <code>lookup_order<\/code>, returned the error unavailable<\/summary>/);
  expect(html).toContain("Handed over to a person in turn 2.");
  expect(html).toContain("Customer message 2 of 3 · Not reached</p><div class=\"bubble\">Și dacă nu ajunge până vineri?\n\nE un cadou.</div>");
  expect(html.match(/<div class="unreached">/g)?.length ?? 0).toBe(listed.filter((id) => cut.has(id)).length);
  for (const criterion of Criterion.options) expect(html).toContain(`value="${criterion}"`);
  expect(html).toContain("Every fact the agent states about an order, the shop's policy");
  expect(html).toContain("<h3>Shop policy</h3>");
  expect(html).not.toContain("<h3>The verdict file</h3>");
  for (const hidden of ["agent-alpha", "agent-beta", "run-1", "secret-case", "alt-case", "uuid-of", "812.5", "0.0151", "431.25", '"resolved"', HIDDEN_NOTE]) {
    expect(html).not.toContain(hidden);
  }
  expect(html.indexOf("<meta charset=\"utf-8\">")).toBeLessThan(200);
  expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"`);
  expect(html).not.toMatch(/\b(src|href)="?(https?:)?\/\//);
  expect(html).not.toMatch(/@import|url\(/);
});

test("the sheet refuses an id the packet does not hold, an id listed twice, and a page Git would track", async () => {
  const { work, packet, ids } = await packetDir();
  const build = async (list: string, out = join(work, "sheet.html")) => {
    await writeFile(join(work, "ids.txt"), list);
    return main(["audit-sheet", "--packet", packet, "--ids", join(work, "ids.txt"), "--out", out], ROOT);
  };

  await expect(build(`${ids[0]}\nfeedface\n`)).rejects.toThrow(/names feedface, but the packet holds no/);
  await expect(build(`${ids[0]}\n${ids[1]}\n${ids[0]}\n`)).rejects.toThrow(/line 3 names .* a second time/);
  await expect(build("\n")).rejects.toThrow(/names no conversation/);
  await expect(build(`${ids[0]}\n`, join(ROOT, "docs", "sheet.html"))).rejects.toThrow(/not ignored by Git/);
  await expect(main(["audit-sheet", "--packet", packet, "--out", "x.html"], ROOT)).rejects.toThrow(/usage/);
});

test("the sheet reads every conversation the saved model runs put in a packet", async () => {
  const work = await tempDir();
  const keyFile = join(work, "key.json");
  await main(["audit-packet", "--out", join(work, "packet"), "--key", keyFile, "--seed", "test"], ROOT);
  const ids = (await readJson(keyFile, AuditKey)).conversations.map((c) => c.id);
  await writeFile(join(work, "ids.txt"), ids.join("\n"));

  await main(["audit-sheet", "--packet", join(work, "packet"), "--ids", join(work, "ids.txt"), "--out", join(work, "all.html")], ROOT);

  const html = await readFile(join(work, "all.html"), "utf8");
  expect(html.match(/<section class="conversation"/g)).toHaveLength(ids.length);
});

type PageAnswer = { acceptable: boolean | null; failing: string[]; note: string };
type PageLogic = {
  problem(answer: PageAnswer | undefined): string | undefined;
  verdictFile(ids: string[], answers: Record<string, PageAnswer>, criteria: readonly string[]): string;
  answerFrom(value: unknown, criteria: readonly string[]): PageAnswer;
};

const pageLogic = async (): Promise<PageLogic> =>
  runInNewContext(`${await readFile(join(ROOT, "src", "sheet-page.js"), "utf8")}\nsheet`, {}) as PageLogic;

test("the page's script writes a verdict line only for a finished answer, and the loader accepts every line it writes", async () => {
  const sheet = await pageLogic();
  const ids = ["a1", "b2", "c3", "d4", "e5"];
  const answers: Record<string, PageAnswer> = {
    a1: { acceptable: true, failing: [], note: "" },
    b2: { acceptable: false, failing: ["promises", "facts"], note: "Turn 4 promises the refund by Friday." },
    c3: { acceptable: false, failing: ["reply"], note: "The reply is in English." },
    d4: { acceptable: false, failing: [], note: "Turn 2 is wrong." },
  };

  expect(sheet.problem(answers.c3)).toMatch(/Name the turn/);
  expect(sheet.problem(answers.d4)).toMatch(/Tick each criterion/);
  expect(sheet.problem(undefined)).toMatch(/Mark it/);
  const file = sheet.verdictFile(ids, answers, Criterion.options);
  const loaded = parseVerdicts(file, "human.jsonl", ids, { partial: true });

  expect(file.split("\n").map((line) => line && JSON.parse(line).id)).toEqual(["a1", "b2", ""]);
  expect(loaded.get("a1")).toEqual({
    id: "a1",
    acceptable: true,
    ...Object.fromEntries(Criterion.options.map((name) => [name, true])),
    note: "No criterion fails.",
  });
  expect(loaded.get("b2")).toMatchObject({ acceptable: false, promises: false, facts: false, outcome: true, reply: true });
  expect(sheet.answerFrom({ acceptable: true, failing: ["facts"], note: 3 }, Criterion.options)).toEqual({ acceptable: true, failing: [], note: "" });
  expect(sheet.answerFrom({ acceptable: false, failing: ["facts", "made-up"], note: "Turn 1" }, Criterion.options)).toEqual({
    acceptable: false,
    failing: ["facts"],
    note: "Turn 1",
  });
  expect(sheet.answerFrom("junk", Criterion.options)).toEqual({ acceptable: null, failing: [], note: "" });
});
