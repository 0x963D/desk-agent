import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { agreementReport, kappa, parseVerdicts } from "../src/agreement.ts";
import { main } from "../src/cli.ts";
import { readJson } from "../src/files.ts";
import { passed } from "../src/grade.ts";
import { buildPacket, type Source } from "../src/packet.ts";
import { AuditKey, Conversation, Criterion, TestResult, type Verdict } from "../src/shapes.ts";
import { ROOT, tempDir } from "./helpers.ts";

const DOCS = { scope: "the scope", judging: "the rubric" };

function source(agent: string, case_id: string, run = `results/${agent}/run-1`): Source {
  const conversation = Conversation.parse({
    conversation_id: `uuid-of-${case_id}-${agent}`,
    case_id,
    split: "held-out",
    agent,
    turns: [
      { role: "customer", text: "Where is order SC-2001?\nThe email is ana@example.com." },
      {
        role: "agent",
        text: "A colleague will take over.",
        status: "open",
        tool_calls: [
          {
            name: "lookup_order",
            input: { order_id: "SC-2001", email: "ana@example.com" },
            output: { ok: false, error: { code: "unavailable", message: "The shop system is not answering." } },
          },
          {
            name: "hand_over",
            input: { reason: "system_failure", summary: "Tracking for SC-2001 during an outage." },
            output: { ok: true, data: { handover_id: "H-1" } },
          },
        ],
        duration_ms: 812.5,
        cost_usd: 0.0151,
      },
    ],
  });
  return { agent, run, conversation };
}

const SOURCES = [
  source("agent-alpha", "en-secret-case"),
  source("agent-alpha", "ro-alt-caz"),
  source("agent-beta", "en-secret-case"),
  source("agent-beta", "ro-alt-caz"),
];

const conversationFiles = (files: ReadonlyMap<string, string>) =>
  [...files].filter(([path]) => path.startsWith("conversations/"));

test("a packet file shows the turns, the function calls and the handover, and nothing that names the source", () => {
  const { files } = buildPacket(SOURCES, "seed", DOCS);

  const shown = conversationFiles(files);
  expect(shown).toHaveLength(4);
  for (const [, text] of shown) {
    expect(text).toContain("## Turn 1, customer\n\n> Where is order SC-2001?\n> The email is ana@example.com.");
    expect(text).toContain("## Turn 2, agent");
    expect(text).toContain("`lookup_order`");
    expect(text).toContain('"code": "unavailable"');
    expect(text).toContain("Reply:\n\n> A colleague will take over.");
    expect(text).toContain("handed the conversation to a person in turn 2.\n\nReason: `system_failure`");
    expect(text).toContain("> Tracking for SC-2001 during an outage.");
    for (const hidden of ["agent-alpha", "agent-beta", "run-1", "secret-case", "alt-caz", "uuid-of", "812", "0.0151", '"open"']) {
      expect(text).not.toContain(hidden);
    }
  }
  expect(files.get("scope.md")).toBe("the scope");
  expect(files.get("judging.md")).toBe("the rubric");
});

test("the key maps each random id to its agent, run and case, and the verdict file lists the same ids in packet order", () => {
  const { key, files } = buildPacket(SOURCES, "seed", DOCS);

  expect(key.seed).toBe("seed");
  expect(key.conversations.map(({ agent, case_id }) => `${agent} ${case_id}`).sort()).toEqual([
    "agent-alpha en-secret-case",
    "agent-alpha ro-alt-caz",
    "agent-beta en-secret-case",
    "agent-beta ro-alt-caz",
  ]);
  const ids = key.conversations.map((c) => c.id);
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(files.get(`conversations/${id}.md`)).toMatch(new RegExp(`^# Conversation ${id}\n`));
  }
  const template = files.get("verdicts.jsonl")!;
  expect(template.trim().split("\n").map((line) => JSON.parse(line).id)).toEqual(ids);
  expect(() => parseVerdicts(template, "verdicts.jsonl", ids)).toThrow(/line 1/);
});

test("the same seed builds the same packet, and another seed shuffles it again", () => {
  const first = buildPacket(SOURCES, "seed", DOCS);
  const again = buildPacket(SOURCES, "seed", DOCS);
  const other = buildPacket(SOURCES, "another seed", DOCS);

  expect([...again.files]).toEqual([...first.files]);
  expect(again.key).toEqual(first.key);
  expect(other.key.conversations.map((c) => c.id)).not.toEqual(first.key.conversations.map((c) => c.id));
});

const IDS = ["a", "b", "c"];

function verdict(id: string, failing: Criterion[] = [], note = "Meets every criterion."): Verdict {
  return {
    id,
    acceptable: failing.length === 0,
    ...(Object.fromEntries(Criterion.options.map((name) => [name, !failing.includes(name)])) as Record<Criterion, boolean>),
    note,
  };
}

const lines = (...verdicts: unknown[]) => verdicts.map((v) => JSON.stringify(v)).join("\n");

test("a verdict file that judges every conversation loads", () => {
  const loaded = parseVerdicts(
    `${lines(verdict("c"), verdict("a", ["facts"], "Turn 4 states a time no function gave."), verdict("b"))}\n`,
    "reader.jsonl",
    IDS,
  );

  expect([...loaded.keys()].sort()).toEqual(IDS);
  expect(loaded.get("a")).toMatchObject({ acceptable: false, facts: false, outcome: true });
});

test.each([
  ["misses a conversation", lines(verdict("a"), verdict("b")), /misses 1 of 3 conversations: c/],
  ["names an id the key does not hold", lines(verdict("a"), verdict("b"), verdict("c"), verdict("d")), /names d, which the key does not hold/],
  ["names an id twice", lines(verdict("a"), verdict("b"), verdict("b"), verdict("c")), /names b a second time/],
  ["is not JSON", "{id: a}", /line 1 is not JSON/],
  ["leaves a field empty", lines({ ...verdict("a"), promises: null }, verdict("b"), verdict("c")), /promises/],
  ["lacks a criterion", lines((({ privacy, ...rest }) => rest)(verdict("a")), verdict("b"), verdict("c")), /privacy/],
  ["calls a failing conversation acceptable", lines({ ...verdict("a", ["promises"], "Turn 2 promises a refund."), acceptable: true }, verdict("b"), verdict("c")), /acceptable is true exactly when no criterion fails/],
  ["calls a passing conversation unacceptable", lines({ ...verdict("a"), acceptable: false }, verdict("b"), verdict("c")), /acceptable is true exactly when no criterion fails/],
  ["gives a failure a note that names no turn", lines(verdict("a", ["reply"], "The reply is in English."), verdict("b"), verdict("c")), /names the turn/],
  ["leaves the note empty", lines(verdict("a", [], " "), verdict("b"), verdict("c")), /note/],
])("a verdict file that %s is rejected", (_, text, message) => {
  expect(() => parseVerdicts(text, "reader.jsonl", IDS)).toThrow(message);
});

// By hand: 10 conversations. A accepts 1-6, B accepts 1-4 and 7.
// Both yes 4, A only 2, B only 1, both no 3. Observed agreement (4 + 3) / 10 = 0.7.
// Chance agreement 0.6 x 0.5 + 0.4 x 0.5 = 0.5. Kappa (0.7 - 0.5) / (1 - 0.5) = 0.4.
const A = [true, true, true, true, true, true, false, false, false, false];
const B = [true, true, true, true, false, false, true, false, false, false];

test("Cohen's kappa matches a hand count", () => {
  expect(kappa(A, B)).toBeCloseTo(0.4, 10);
  expect(kappa(A, A)).toBe(1);
  expect(kappa([true, false], [false, true])).toBe(-1);
  expect(kappa([true, true], [true, true])).toBeUndefined();
});

test("the agreement report counts each reader against the grader and each pair against each other", () => {
  const ids = A.map((_, at) => `id${at + 1}`);
  const key = AuditKey.parse({
    seed: "s",
    conversations: ids.map((id, at) => ({ id, agent: at < 5 ? "alpha" : "beta", run: "r", case_id: `case-${at}` })),
  });
  const automatic = new Map(ids.map((id, at) => [id, at !== 9]));
  const reader = (name: string, accepts: boolean[], failing: Criterion) => ({
    name,
    verdicts: new Map(ids.map((id, at) => [id, accepts[at] ? verdict(id) : verdict(id, [failing], "Turn 2 fails.")])),
  });

  const printed = agreementReport(key, automatic, [reader("ana", A, "facts"), reader("bo", B, "promises")]);

  expect(printed).toContain(
    [
      "reader ana",
      "  agent   acceptable   automatic pass",
      "  alpha          5/5              5/5",
      "  beta           1/5              4/5",
      "  agrees with the automatic grader on 7/10 (70%), kappa 0.29",
      "                          automatic pass   automatic fail",
      "  reader acceptable                    6                0",
      "  reader not acceptable                3                1",
      "  failed criterion   all   alpha   beta",
      "  facts                4       0      4",
    ].join("\n"),
  );
  expect(printed).toContain(
    [
      "readers ana and bo",
      "  agree on acceptable for 7/10 (70%), kappa 0.40",
      "  disagree on 3: id5, id6, id7",
    ].join("\n"),
  );
});

async function fill(dir: string, file: string, judge: (id: string) => Verdict) {
  const template = await readFile(join(dir, "verdicts.jsonl"), "utf8");
  const ids = template.trim().split("\n").map((line) => JSON.parse(line).id as string);
  await writeFile(file, `${ids.map((id) => JSON.stringify(judge(id))).join("\n")}\n`);
}

test("the saved model runs build a packet of 108 conversations, and filled verdicts feed the agreement report", async () => {
  const work = await tempDir();
  const out = join(work, "packet");
  const keyFile = join(work, "key.json");

  const printed = await main(["audit-packet", "--out", out, "--key", keyFile, "--seed", "test"], ROOT);

  expect(printed).toContain("packet: 108 conversations from 6 runs");
  expect((await readdir(join(out, "conversations"))).length).toBe(108);
  expect(await readFile(join(out, "judging.md"), "utf8")).toBe(await readFile(join(ROOT, "docs", "judging.md"), "utf8"));
  expect(await readFile(join(out, "scope.md"), "utf8")).toBe(await readFile(join(ROOT, "docs", "scope.md"), "utf8"));
  const key = await readJson(keyFile, AuditKey);
  const perAgent = Map.groupBy(key.conversations, (c) => c.agent);
  expect(Object.fromEntries([...perAgent].map(([agent, list]) => [agent, list.length]))).toEqual({
    "plain-gpt-6-luna": 54,
    "plain-gpt-6.2-sol": 54,
  });

  const grader = new Map<string, boolean>();
  for (const { id, run, case_id } of key.conversations) {
    const results = await readJson(join(ROOT, run, "results.json"), TestResult.array());
    grader.set(id, passed(results.find((r) => r.case_id === case_id)!));
  }
  const failedByGrader = key.conversations.map((c) => c.id).filter((id) => !grader.get(id));
  expect(failedByGrader).toHaveLength(14);
  await mkdir(join(work, "audit"));
  const lenient = join(work, "audit", "lenient.jsonl");
  const strict = join(work, "audit", "as-grader.jsonl");
  await fill(out, lenient, (id) => verdict(id));
  await fill(out, strict, (id) => (grader.get(id) ? verdict(id) : verdict(id, ["outcome"], "Turn 2 ends it wrongly.")));

  const report = await main(["audit-agreement", "--key", keyFile, lenient, strict], ROOT);

  expect(report).toContain("reader lenient\n  agent               acceptable   automatic pass\n  plain-gpt-6-luna         54/54            47/54\n  plain-gpt-6.2-sol        54/54            47/54");
  expect(report).toContain("agrees with the automatic grader on 94/108 (87%), kappa 0.00");
  expect(report).toContain("agrees with the automatic grader on 108/108 (100%), kappa 1.00");
  expect(report).toContain("  no criterion failed");
  expect(report).toContain("  outcome             14                  7                   7");
  expect(report).toContain("readers lenient and as-grader\n  agree on acceptable for 94/108 (87%), kappa 0.00");
  expect(report).toContain(`disagree on 14: ${failedByGrader.join(", ")}`);
});

test("the packet refuses a key inside it, a folder that is not empty and a folder Git tracks", async () => {
  const work = await tempDir();
  const out = join(work, "packet");
  const build = (dir: string, keyFile: string) => main(["audit-packet", "--out", dir, "--key", keyFile], ROOT);

  await expect(build(out, join(out, "key.json"))).rejects.toThrow(/key must live outside the packet/);
  await mkdir(out);
  await writeFile(join(out, "old.md"), "from another packet");
  await expect(build(out, join(work, "key.json"))).rejects.toThrow(/is not empty/);
  await expect(build(join(ROOT, "docs", "packet"), join(work, "key.json"))).rejects.toThrow(/not ignored by Git/);
  expect(await readdir(join(ROOT, "docs"))).not.toContain("packet");
});

test("the audit options belong to the audit commands", async () => {
  await expect(main(["audit-packet", "--out", "x"], ROOT)).rejects.toThrow(/usage/);
  await expect(main(["audit-agreement", "--key", "k.json"], ROOT)).rejects.toThrow(/usage/);
  await expect(main(["report", "--seed", "s"], ROOT)).rejects.toThrow(/usage/);
});
