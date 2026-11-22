import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inside, ignoredByGit, NOT_REACHED } from "./packet.ts";
import { Criterion, ToolCall } from "./shapes.ts";

// One conversation as a packet file shows it, read back from the Markdown that `renderConversation` writes.
export type ShownTurn =
  | { number: number; role: "customer"; text: string }
  | { number: number; role: "agent"; calls: ToolCall[]; reply: string };
export type ShownHandover = { turn: number; reason: string; order: string | undefined; summary: string };
export type ShownUnplayed = { message: number; of: number; text: string };
export type ShownConversation = {
  id: string;
  turns: ShownTurn[];
  handover: ShownHandover | undefined;
  unplayed: ShownUnplayed[];
};

// A rubric criterion as the table in judging.md states it.
export type CriterionTest = { name: Criterion; title: string; test: string };

export type Sheet = {
  conversations: readonly ShownConversation[];
  criteria: readonly CriterionTest[];
  rubric: string;
  scope: string;
};

export const SHEET_FILE_NAME = "human.jsonl";

export function parseConversation(text: string, file: string): ShownConversation {
  const blocks = text.replace(/\n$/, "").split("\n\n");
  let at = 0;
  const fail = (wanted: string): never => {
    const found = blocks[at] === undefined ? "the end of the file" : JSON.stringify(blocks[at]!.slice(0, 60));
    throw new Error(`${file} block ${at + 1}: expected ${wanted}, found ${found}`);
  };
  const take = (pattern: RegExp, wanted: string): string[] => {
    const match = pattern.exec(blocks[at] ?? "");
    if (!match) return fail(wanted);
    at++;
    return match.slice(1);
  };
  const quoted = (): string => {
    const lines = (blocks[at] ?? "").split("\n");
    if (blocks[at] === undefined || !lines.every((line) => line === ">" || line.startsWith("> "))) fail("a quoted text");
    at++;
    return lines.map((line) => line.slice(2)).join("\n");
  };
  const json = (): unknown => JSON.parse(take(/^```json\n([\s\S]*)\n```$/, "a JSON block")[0]!);

  const [id] = take(/^# Conversation (\S+)$/, "the conversation heading");
  const turns: ShownTurn[] = [];
  const turnHeading = () => /^## Turn (\d+), (customer|agent)$/.exec(blocks[at] ?? "");
  for (let head = turnHeading(); head; head = turnHeading()) {
    at++;
    const number = Number(head[1]);
    if (head[2] === "customer") {
      turns.push({ number, role: "customer", text: quoted() });
      continue;
    }
    const calls: ToolCall[] = [];
    while (blocks[at]?.startsWith("Function call ")) {
      const [name] = take(/^Function call \d+: `([^`]+)`$/, "a function call heading");
      take(/^Input:$/, "Input:");
      const input = json();
      take(/^Result:$/, "Result:");
      calls.push(ToolCall.parse({ name, input, output: json() }));
    }
    take(/^Reply:$/, "Reply:");
    turns.push({ number, role: "agent", calls, reply: quoted() });
  }
  take(/^## Handover$/, "the handover heading");
  let handover: ShownHandover | undefined;
  if (blocks[at] === "The agent made no handover.") {
    at++;
  } else {
    const [turn] = take(/^The agent handed the conversation to a person in turn (\d+)\.$/, "the handover turn");
    const [reason] = take(/^Reason: `([^`]+)`$/, "the handover reason");
    const order = /^Order: (.+)$/.test(blocks[at] ?? "") ? take(/^Order: (.+)$/, "the order")[0] : undefined;
    take(/^Summary:$/, "Summary:");
    handover = { turn: Number(turn), reason: reason!, order, summary: quoted() };
  }
  const unplayed: ShownUnplayed[] = [];
  if (blocks[at] === "## Not reached") {
    at++;
    if (blocks[at] !== NOT_REACHED) fail("the note on messages not reached");
    at++;
    const heading = () => /^### Customer message (\d+) of (\d+)$/.exec(blocks[at] ?? "");
    for (let head = heading(); head; head = heading()) {
      at++;
      unplayed.push({ message: Number(head[1]), of: Number(head[2]), text: quoted() });
    }
    if (unplayed.length === 0) fail("a customer message not reached");
  }
  if (at !== blocks.length) fail("the end of the file");
  return { id: id!, turns, handover, unplayed };
}

const section = (markdown: string, heading: string) =>
  new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m").exec(markdown)?.[0] ?? "";

export function parseCriteria(judging: string): CriterionTest[] {
  const criteria = [...section(judging, "The criteria").matchAll(/^\| `(\w+)` \| (.+?) \| (.+?) \|$/gm)].map(([, name, title, test]) => ({
    name: Criterion.parse(name),
    title: title!,
    test: test!,
  }));
  if (criteria.map((c) => c.name).join() !== Criterion.options.join()) {
    throw new Error(`judging.md must list the criteria ${Criterion.options.join(", ")} in its table, in that order`);
  }
  return criteria;
}

export function parseIds(text: string, file: string): string[] {
  const ids: string[] = [];
  text.split("\n").forEach((line, at) => {
    const id = line.trim();
    if (id === "") return;
    if (ids.includes(id)) throw new Error(`${file} line ${at + 1} names ${id} a second time`);
    ids.push(id);
  });
  if (ids.length === 0) throw new Error(`${file} names no conversation`);
  return ids;
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// The Markdown the scope and the rubric use: headings, paragraphs, lists, tables and tab-indented code.
export function markdownToHtml(markdown: string, { shift }: { shift: number }): string {
  const html: string[] = [];
  const lines = markdown.split("\n");
  for (let at = 0; at < lines.length; ) {
    const line = lines[at]!;
    const run = (test: (l: string) => boolean) => {
      const start = at;
      while (at < lines.length && test(lines[at]!)) at++;
      return lines.slice(start, at);
    };
    const heading = /^(#+) (.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + shift, 6);
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      at++;
    } else if (line.startsWith("|")) {
      const cells = (row: string) => row.slice(1, -1).split("|").map((cell) => inline(cell.trim()));
      const [head, , ...body] = run((l) => l.startsWith("|"));
      html.push(
        `<table><thead><tr>${cells(head!).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body
          .map((row) => `<tr>${cells(row).map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    } else if (line.startsWith("- ")) {
      html.push(`<ul>${run((l) => l.startsWith("- ")).map((item) => `<li>${inline(item.slice(2))}</li>`).join("")}</ul>`);
    } else if (line.startsWith("\t")) {
      html.push(`<pre><code>${escape(run((l) => l.startsWith("\t")).map((l) => l.slice(1)).join("\n"))}</code></pre>`);
    } else if (line.trim() === "") {
      at++;
    } else {
      const paragraph = run((l) => l.trim() !== "" && !/^(#|\||- |\t)/.test(l));
      html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    }
  }
  return html.join("\n");
}

// The rubric without its last section, which tells a packet reader how to fill verdicts.jsonl by hand.
// The sheet writes that file itself.
const rubricForSheet = (judging: string) => judging.replace(section(judging, "The verdict file"), "");

const callResult = (call: ToolCall) => (call.output.ok ? "returned a result" : `returned the error ${call.output.error.code}`);

const pretty = (value: unknown) => escape(JSON.stringify(value, null, 2));

function renderTurn(turn: ShownTurn): string {
  if (turn.role === "customer") {
    return `<li class="turn customer"><p class="who">Turn ${turn.number} · Customer</p><div class="bubble">${escape(turn.text)}</div></li>`;
  }
  const calls = turn.calls.map(
    (call, index) =>
      `<details class="call"><summary>Function call ${index + 1}: <code>${escape(call.name)}</code>, ${callResult(call)}</summary>` +
      `<p class="label">Input</p><pre>${pretty(call.input)}</pre><p class="label">Result</p><pre>${pretty(call.output)}</pre></details>`,
  );
  return `<li class="turn agent"><p class="who">Turn ${turn.number} · Agent</p>${calls.join("")}<div class="bubble">${escape(turn.reply)}</div></li>`;
}

function renderHandover(handover: ShownHandover | undefined): string {
  if (!handover) return `<p class="handover none">The agent made no handover.</p>`;
  return [
    `<div class="handover"><p><strong>Handed over to a person in turn ${handover.turn}.</strong></p>`,
    `<p>Reason: <code>${escape(handover.reason)}</code></p>`,
    handover.order ? `<p>Order: ${escape(handover.order)}</p>` : "",
    `<p class="label">Summary for staff</p><div class="bubble">${escape(handover.summary)}</div></div>`,
  ].join("");
}

function renderUnplayed(unplayed: readonly ShownUnplayed[]): string {
  if (unplayed.length === 0) return "";
  const messages = unplayed.map(
    (m) =>
      `<li class="turn customer"><p class="who">Customer message ${m.message} of ${m.of} · Not reached</p><div class="bubble">${escape(m.text)}</div></li>`,
  );
  return `<div class="unreached"><p class="label">Not reached</p><p>${escape(NOT_REACHED)}</p><ol class="chat">${messages.join("")}</ol></div>`;
}

function renderConversationForm(conversation: ShownConversation, at: number, count: number, criteria: readonly CriterionTest[]): string {
  const id = escape(conversation.id);
  const boxes = criteria
    .map(
      (c) =>
        `<label class="criterion"><input type="checkbox" name="failing" value="${c.name}"><span><strong>${inline(c.title)}</strong> <code>${c.name}</code><span class="test">${inline(c.test)}</span></span></label>`,
    )
    .join("");
  return `<section class="conversation" data-id="${id}" aria-labelledby="h-${id}">
<header class="conversation-head"><h2 id="h-${id}" tabindex="-1">Conversation ${at + 1} of ${count}</h2><p class="state" aria-live="polite">To do</p></header>
<ol class="chat">${conversation.turns.map(renderTurn).join("")}</ol>
${renderHandover(conversation.handover)}
${renderUnplayed(conversation.unplayed)}
<div class="judge">
<fieldset class="acceptable"><legend>Is this conversation acceptable?</legend>
<label class="choice"><input type="radio" name="acceptable-${id}" value="yes"> Acceptable</label>
<label class="choice"><input type="radio" name="acceptable-${id}" value="no"> Not acceptable</label>
</fieldset>
<fieldset class="criteria"><legend>Tick each criterion it fails</legend>${boxes}</fieldset>
<label class="note-label" for="note-${id}">Note <span class="optional">(when it fails, name the turn, such as “Turn 4 promises a refund.”)</span></label>
<textarea id="note-${id}" name="note" rows="2"></textarea>
<p class="hint" aria-live="polite"></p>
</div>
</section>`;
}

// One self-contained page. Its policy forbids every request, so the page cannot reach the network.
export function renderSheet(sheet: Sheet, assets: { css: string; script: string }): string {
  const ids = sheet.conversations.map((c) => c.id);
  const data = {
    ids,
    criteria: sheet.criteria.map((c) => c.name),
    storageKey: `label-sheet:${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16)}`,
    fileName: SHEET_FILE_NAME,
  };
  const embedded = JSON.stringify(data).replaceAll("<", "\\u003c");
  const count = sheet.conversations.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Label sheet</title>
<style>
${assets.css}
</style>
</head>
<body>
<header class="bar">
<p class="progress"><span id="done-count">0</span> of ${count} done</p>
<div class="actions">
<button type="button" id="next">Next to do</button>
<button type="button" id="rules-open" aria-haspopup="dialog">Rules</button>
<button type="button" id="download" class="primary">Download verdicts</button>
</div>
</header>
<main>
<h1>Label sheet</h1>
<div class="intro">
<p>Read each conversation and judge it against the rubric. Mark it acceptable or not acceptable. When it is not acceptable, tick every criterion it fails and write a note that names the turn.</p>
<p>The function calls are folded under each agent turn. Open one to see its input and result. <strong>Rules</strong> at the top holds the rubric and the scope.</p>
<p>This browser keeps your answers as you go, so you can close the tab and come back. When the counter reads ${count} of ${count}, press <strong>Download verdicts</strong>.</p>
<p class="storage-warning" id="storage-warning" hidden>This browser is not keeping your answers. Download the verdicts before you close the tab.</p>
<p class="saved" id="saved" aria-live="polite"></p>
</div>
${sheet.conversations.map((c, at) => renderConversationForm(c, at, count, sheet.criteria)).join("\n")}
</main>
<dialog id="rules" aria-labelledby="rules-title">
<div class="rules-head"><h2 id="rules-title">Rules</h2><nav><a href="#rubric">Rubric</a> <a href="#scope">Scope</a></nav><button type="button" id="rules-close">Close</button></div>
<section id="rubric" class="doc">${sheet.rubric}</section>
<section id="scope" class="doc">${sheet.scope}</section>
</dialog>
<script type="application/json" id="sheet-data">${embedded}</script>
<script>
${assets.script}
</script>
</body>
</html>
`;
}

const asset = (name: string) => readFile(join(import.meta.dirname, name), "utf8");

export async function writeSheet(root: string, { packet, ids, out }: { packet: string; ids: string; out: string }): Promise<string> {
  if (inside(root, out) && !ignoredByGit(root, out)) {
    throw new Error(`${out} is inside the repository and not ignored by Git. Write the sheet outside it or under .artifacts/`);
  }
  const listed = parseIds(await readFile(ids, "utf8"), ids);
  const conversations = await Promise.all(
    listed.map(async (id) => {
      const file = join(packet, "conversations", `${id}.md`);
      const text = await readFile(file, "utf8").catch(() => {
        throw new Error(`${ids} names ${id}, but the packet holds no ${join("conversations", `${id}.md`)}`);
      });
      return parseConversation(text, file);
    }),
  );
  const [judging, scope, css, script] = await Promise.all([
    readFile(join(packet, "judging.md"), "utf8"),
    readFile(join(packet, "scope.md"), "utf8"),
    asset("sheet-page.css"),
    asset("sheet-page.js"),
  ]);
  const sheet: Sheet = {
    conversations,
    criteria: parseCriteria(judging),
    rubric: markdownToHtml(rubricForSheet(judging), { shift: 1 }),
    scope: markdownToHtml(scope, { shift: 1 }),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderSheet(sheet, { css, script }));
  return `sheet: ${conversations.length} conversations in ${out}\nthe page downloads ${SHEET_FILE_NAME}`;
}
