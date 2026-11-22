import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../src/cli.ts";
import { readJson } from "../src/files.ts";
import { TestResult } from "../src/shapes.ts";
import { copyOfRepoData, ROOT, tempDir } from "./helpers.ts";

const savedResults = (out: string, split: string) =>
  readJson(join(out, "rule-based", split, "results.json"), TestResult.array());

test("tune runs the tuning cases through the rule-based agent and prints the summary", async () => {
  const out = await tempDir();

  const printed = await main(["tune"], { root: ROOT, out });

  expect(printed).toContain("tuning: 3 conversations");
  expect(printed).toContain("resolved correctly     2/3 (67%)");
  expect(printed).not.toContain("held-out");
  expect((await savedResults(out, "tuning")).map((r) => [r.case_id, r.split, r.observed])).toEqual([
    ["en-other-customers-details", "tuning", "refused"],
    ["ro-order-status", "tuning", "resolved"],
    ["ro-return-within-window", "tuning", "resolved"],
  ]);
});

test("score runs the held-out cases", async () => {
  const out = await tempDir();

  const printed = await main(["score"], { root: ROOT, out });

  expect(printed).toContain("held-out: 3 conversations");
  expect((await savedResults(out, "held-out")).map((r) => [r.case_id, r.observed])).toEqual([
    ["en-asks-for-a-person", "handed_over"],
    ["en-change-delivery-address", "handed_over"],
    ["ro-injected-refund", "refused"],
  ]);
});

test.each([[["tune", "held-out"]], [["tune", "--split=held-out"]], [["score", "tuning"]], [[]]])(
  "%j is refused: neither run command takes a split",
  async (args) => {
    await expect(main(args, { root: ROOT, out: await tempDir() })).rejects.toThrow("usage:");
  },
);

test("regrading a saved run reproduces its results and summary without running the agent", async () => {
  const out = await tempDir();
  const printed = await main(["score"], { root: ROOT, out });
  const results = await savedResults(out, "held-out");

  const reprinted = await main(["regrade", "held-out"], { root: ROOT, out });

  expect(reprinted).toBe(printed);
  expect(await savedResults(out, "held-out")).toEqual(results);
});

test("regrading applies the case as it reads now", async () => {
  const root = await copyOfRepoData();
  const out = await tempDir();
  await main(["tune"], { root, out });
  const caseFile = join(root, "cases", "tuning", "ro-order-status.yaml");
  await writeFile(caseFile, (await readFile(caseFile, "utf8")).replace("AWB7001", "AWB9999"));

  const reprinted = await main(["regrade", "tuning"], { root, out });

  expect(reprinted).toContain("FAIL  missing_mention: AWB9999");
  expect(reprinted).toContain("passed every check     2/3 (67%)");
});
