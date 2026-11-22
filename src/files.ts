import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Fixtures } from "./backend.ts";
import { TestCase, type Split } from "./shapes.ts";

function parseAs<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${file}\n${z.prettifyError(result.error)}`);
  return result.data;
}

async function readYaml<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return parseAs(schema, parseYaml(await readFile(file, "utf8")), file);
}

export async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return parseAs(schema, JSON.parse(await readFile(file, "utf8")), file);
}

export async function writeJson<T>(file: string, schema: z.ZodType<T>, value: T): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(parseAs(schema, value, file), null, 2)}\n`);
}

export function loadFixtures(root: string): Promise<Fixtures> {
  return readYaml(join(root, "fixtures", "shop.yaml"), Fixtures);
}

export async function loadCases(root: string, split: Split): Promise<TestCase[]> {
  const dir = join(root, "cases", split);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
  const cases = await Promise.all(names.map((name) => readYaml(join(dir, name), TestCase)));
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (testCase.split !== split) {
      throw new Error(`${dir}: case ${testCase.id} declares split ${testCase.split}`);
    }
    if (seen.has(testCase.id)) throw new Error(`${dir}: case id ${testCase.id} appears twice`);
    seen.add(testCase.id);
  }
  if (cases.length === 0) throw new Error(`${dir}: no cases`);
  return cases;
}
