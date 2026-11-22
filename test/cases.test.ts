import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "../src/files.ts";
import { ROOT, tempDir } from "./helpers.ts";

const CASE = `
id: example
split: tuning
language: en
customer_id: C-1001
summary: An example.
turns:
  - Hello
expect:
  outcome: resolved
`;

async function rootWithTuningCase(yaml: string): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, "cases", "tuning"), { recursive: true });
  await writeFile(join(root, "cases", "tuning", "example.yaml"), yaml);
  return root;
}

test("the example set is three Romanian and three English cases that expect every outcome", async () => {
  const cases = [...(await loadCases(ROOT, "tuning")), ...(await loadCases(ROOT, "held-out"))];

  expect(cases.map((c) => c.language).sort()).toEqual(["en", "en", "en", "ro", "ro", "ro"]);
  expect(new Set(cases.map((c) => c.expect.outcome))).toEqual(
    new Set(["resolved", "handed_over", "refused"]),
  );
});

test("loading a split returns only that split's cases", async () => {
  const tuning = await loadCases(ROOT, "tuning");
  const heldOut = await loadCases(ROOT, "held-out");

  expect(tuning.map((c) => c.split)).toEqual(["tuning", "tuning", "tuning"]);
  expect(heldOut.map((c) => c.split)).toEqual(["held-out", "held-out", "held-out"]);
});

test("a case that omits optional expectations expects no requests and no phrases", async () => {
  const [loaded] = await loadCases(await rootWithTuningCase(CASE), "tuning");

  expect(loaded?.expect).toEqual({
    outcome: "resolved",
    requests: [],
    reply_mentions: [],
    reply_never_mentions: [],
  });
});

test("a held-out case filed in the tuning folder is rejected", async () => {
  const root = await rootWithTuningCase(CASE.replace("split: tuning", "split: held-out"));

  await expect(loadCases(root, "tuning")).rejects.toThrow("declares split held-out");
});

test("a misspelled expectation is rejected and the error names the file", async () => {
  const root = await rootWithTuningCase(`${CASE}  reply_never_mention: [secret]\n`);

  await expect(loadCases(root, "tuning")).rejects.toThrow(/example\.yaml[\s\S]*reply_never_mention/);
});
