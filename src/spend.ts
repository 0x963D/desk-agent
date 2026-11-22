import { join } from "node:path";
import { z } from "zod";
import { readJson, unlessMissing, writeJson } from "./files.ts";

const DEFAULT_CAP_USD = 50;

const Spend = z.strictObject({ spent_usd: z.number().nonnegative() });

export const spendFile = (root: string) => join(root, ".artifacts", "spend.json");

export function spendCap(env: NodeJS.ProcessEnv = process.env): number {
  const set = env.SPEND_CAP_USD?.trim();
  if (!set) return DEFAULT_CAP_USD;
  const cap = Number(set);
  if (!Number.isFinite(cap) || cap < 0) throw new Error("SPEND_CAP_USD must be a number of US dollars, such as 50");
  return cap;
}

export type SpendGuard = {
  allow(): Promise<void>;
  add(cost_usd: number): Promise<void>;
};

export function spendGuard(file: string, cap_usd: number): SpendGuard {
  const spent = async () => (await unlessMissing(readJson(file, Spend), { spent_usd: 0 })).spent_usd;
  return {
    async allow() {
      const so_far = await spent();
      if (so_far >= cap_usd) {
        throw new Error(
          `the recorded spend of $${so_far.toFixed(2)} in ${file} has reached the cap set by SPEND_CAP_USD, so no live call was made. Raising the cap needs the maintainer's approval.`,
        );
      }
    },
    async add(cost_usd) {
      await writeJson(file, Spend, { spent_usd: (await spent()) + cost_usd });
    },
  };
}
