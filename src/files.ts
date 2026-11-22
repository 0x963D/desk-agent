import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  Conversation,
  Email,
  Order,
  Shop,
  TestCase,
  type Split,
} from "./shapes.ts";

const ORDER_RANGE: Record<Split, [number, number]> = { tuning: [1000, 1999], "held-out": [2000, 2999] };
const EMAIL_IN_TEXT = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;

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

export async function unlessMissing<T, F>(read: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await read;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function filesIn(dir: string, extension: string): Promise<string[]> {
  const names = await unlessMissing(readdir(dir), []);
  return names
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => join(dir, name));
}

export const caseDir = (root: string, split: Split) => join(root, "cases", split);
export const orderFile = (root: string, split: Split) => join(root, "fixtures", `${split}.yaml`);

export function loadShop(root: string): Promise<Shop> {
  return readYaml(join(root, "fixtures", "shop.yaml"), Shop);
}

export async function loadOrders(root: string, split: Split): Promise<Order[]> {
  const file = orderFile(root, split);
  const text = await unlessMissing(readFile(file, "utf8"), undefined);
  if (text === undefined) return [];
  const { orders } = parseAs(z.strictObject({ orders: z.array(Order) }), parseYaml(text), file);
  const [low, high] = ORDER_RANGE[split];
  const seen = new Set<string>();
  for (const { order_id } of orders) {
    const number = Number(order_id.slice(3));
    if (number < low || number > high) {
      throw new Error(`${file}: ${order_id} is outside the ${split} range SC-${low} to SC-${high}`);
    }
    if (seen.has(order_id)) throw new Error(`${file}: ${order_id} appears twice`);
    seen.add(order_id);
  }
  return orders;
}

async function loadCase(file: string, split: Split): Promise<TestCase> {
  const testCase = await readYaml(file, TestCase);
  if (testCase.id !== basename(file, ".yaml")) {
    throw new Error(`${file}: the id ${testCase.id} must equal the file name`);
  }
  if (testCase.split !== split) {
    throw new Error(`${file}: the case declares split ${testCase.split} but sits in cases/${split}`);
  }
  for (const email of testCase.turns.join("\n").match(EMAIL_IN_TEXT) ?? []) {
    if (!Email.safeParse(email).success) throw new Error(`${file}: ${email} is not at example.com`);
  }
  return testCase;
}

export async function loadSplit(root: string, split: Split): Promise<{ cases: TestCase[]; orders: Order[] }> {
  const files = await filesIn(caseDir(root, split), ".yaml");
  const [cases, orders] = await Promise.all([
    Promise.all(files.map((file) => loadCase(file, split))),
    loadOrders(root, split),
  ]);
  const known = new Set(orders.map((order) => order.order_id));
  cases.forEach((testCase, at) => {
    for (const { order_id } of testCase.expect.requests) {
      if (!known.has(order_id)) {
        throw new Error(`${files[at]}: expects a request on ${order_id}, which ${orderFile(root, split)} does not hold`);
      }
    }
  });
  return { cases, orders };
}

export async function readConversations(dir: string): Promise<Conversation[]> {
  const files = await filesIn(join(dir, "conversations"), ".json");
  return Promise.all(files.map((file) => readJson(file, Conversation)));
}
