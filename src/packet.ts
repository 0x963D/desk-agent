import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { agents } from "./agents/index.ts";
import { readConversations, unlessMissing, writeJson } from "./files.ts";
import { readLedger, scoredRunDir } from "./ledger.ts";
import { AuditKey, Criterion, type Conversation, type Turn } from "./shapes.ts";
import { handoverOf } from "./trace.ts";

export type Source = { agent: string; run: string; conversation: Conversation };
export type Packet = { key: AuditKey; files: ReadonlyMap<string, string> };

function seeded(seed: string) {
  let counter = 0;
  const next = () => createHash("sha256").update(`${seed}:${counter++}`).digest().readUInt32BE(0);
  return {
    id: () => next().toString(16).padStart(8, "0"),
    below(n: number): number {
      const limit = Math.floor(2 ** 32 / n) * n;
      for (;;) {
        const draw = next();
        if (draw < limit) return draw % n;
      }
    },
  };
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");

const json = (value: unknown) => ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

export function renderConversation(id: string, turns: readonly Turn[]): string {
  const blocks = [`# Conversation ${id}`];
  let handoverTurn = 0;
  turns.forEach((turn, at) => {
    const number = at + 1;
    if (turn.role === "customer") {
      blocks.push(`## Turn ${number}, customer`, quote(turn.text));
      return;
    }
    blocks.push(`## Turn ${number}, agent`);
    turn.tool_calls.forEach((call, index) => {
      blocks.push(`Function call ${index + 1}: \`${call.name}\``, "Input:", json(call.input), "Result:", json(call.output));
      if (handoverTurn === 0 && call.name === "hand_over" && call.output.ok) handoverTurn = number;
    });
    blocks.push("Reply:", quote(turn.text));
  });
  const handover = handoverOf(turns);
  blocks.push("## Handover");
  if (handover) {
    blocks.push(
      [
        `The agent handed the conversation to a person in turn ${handoverTurn}.`,
        `Reason: \`${handover.reason}\``,
        ...(handover.order_id ? [`Order: ${handover.order_id}`] : []),
      ].join("\n\n"),
      "Summary:",
      quote(handover.summary),
    );
  } else {
    blocks.push("The agent made no handover.");
  }
  return `${blocks.join("\n\n")}\n`;
}

const blankVerdict = (id: string) => ({
  id,
  acceptable: null,
  ...Object.fromEntries(Criterion.options.map((name) => [name, null])),
  note: "",
});

export function buildPacket(sources: readonly Source[], seed: string, docs: { scope: string; judging: string }): Packet {
  const random = seeded(seed);
  const order = [...sources];
  for (let at = order.length - 1; at > 0; at--) {
    const other = random.below(at + 1);
    [order[at], order[other]] = [order[other]!, order[at]!];
  }
  const taken = new Set<string>();
  const drawn = order.map((source) => {
    let id = random.id();
    while (taken.has(id)) id = random.id();
    taken.add(id);
    return { id, source };
  });
  const files = new Map([
    ["scope.md", docs.scope],
    ["judging.md", docs.judging],
    ...drawn.map(({ id, source }) => [`conversations/${id}.md`, renderConversation(id, source.conversation.turns)] as const),
    ["verdicts.jsonl", drawn.map(({ id }) => `${JSON.stringify(blankVerdict(id))}\n`).join("")],
  ]);
  const conversations = drawn.map(({ id, source }) => ({
    id,
    agent: source.agent,
    run: source.run,
    case_id: source.conversation.case_id,
  }));
  return { key: AuditKey.parse({ seed, conversations }), files };
}

async function modelRuns(root: string): Promise<Source[]> {
  const sources: Source[] = [];
  for (const entry of await readLedger(root)) {
    if (!agents.get(entry.agent)?.liveModel) continue;
    const conversations = await readConversations(scoredRunDir(root, entry.run));
    if (conversations.length !== entry.summary.cases) {
      throw new Error(
        `${entry.run} holds ${conversations.length} conversations, but its ledger line scored ${entry.summary.cases}`,
      );
    }
    sources.push(...conversations.map((conversation) => ({ agent: entry.agent, run: entry.run, conversation })));
  }
  if (sources.length === 0) throw new Error("the ledger names no scored run of a model agent");
  return sources;
}

const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function ignoredByGit(root: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relative(root, path)], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function writePacket(
  root: string,
  { out, key, seed = randomBytes(8).toString("hex") }: { out: string; key: string; seed?: string | undefined },
): Promise<string> {
  if (inside(out, key)) throw new Error("the key must live outside the packet, so a reader can be handed the packet alone");
  if (inside(root, out) && !ignoredByGit(root, out)) {
    throw new Error(`${relative(root, out)} is not ignored by Git. Write the packet outside the repository or under .artifacts/`);
  }
  if ((await unlessMissing(readdir(out), [])).length > 0) {
    throw new Error(`${out} is not empty. Write the packet into an empty folder, so no file from another packet stays in it`);
  }
  const sources = await modelRuns(root);
  const doc = (name: string) => readFile(join(root, "docs", name), "utf8");
  const [scope, judging] = await Promise.all([doc("scope.md"), doc("judging.md")]);
  const packet = buildPacket(sources, seed, { scope, judging });
  for (const [path, text] of packet.files) {
    const file = join(out, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  await writeJson(key, AuditKey, packet.key);
  const runs = new Set(sources.map((source) => source.run)).size;
  return [
    `packet: ${packet.key.conversations.length} conversations from ${runs} runs in ${out}`,
    `key: ${key}`,
    `seed: ${seed}`,
  ].join("\n");
}
