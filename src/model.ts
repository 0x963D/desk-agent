import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJson } from "./files.ts";
import type { Split } from "./shapes.ts";
import { snapshot } from "./snapshot.ts";
import type { SpendGuard } from "./spend.ts";

export const ModelCall = z.strictObject({
  request: z.unknown(),
  response: z.unknown(),
  duration_ms: z.number().nonnegative(),
  cost_usd: z.number().nonnegative(),
});
export type ModelCall = z.infer<typeof ModelCall>;

export type ModelClient = {
  complete(request: unknown): Promise<Omit<ModelCall, "request">>;
};

export type LiveModel = {
  complete(request: unknown): Promise<{ response: unknown; cost_usd: number }>;
};

export type Recorder = ModelClient & { save(): Promise<void> };

export function recordModel(live: LiveModel, file: string, guard: SpendGuard): Recorder {
  const calls: ModelCall[] = [];
  return {
    async complete(request) {
      await guard.allow();
      const sent = snapshot(request);
      const started = performance.now();
      const { response, cost_usd } = await live.complete(request);
      const duration_ms = performance.now() - started;
      await guard.add(cost_usd);
      const call = ModelCall.parse({ request: sent, response: snapshot(response), duration_ms, cost_usd });
      calls.push(call);
      return call;
    },
    save: () => writeJson(file, ModelCall.array(), calls),
  };
}

export function replayModel(recorded: readonly ModelCall[]): ModelClient {
  let next = 0;
  return {
    async complete(request) {
      const call = recorded[next++];
      if (!call || JSON.stringify(call.request) !== JSON.stringify(request)) {
        throw new Error(`model call ${next} does not match its recording; record it again`);
      }
      return call;
    },
  };
}

export const recordingPath = (root: string, agent: string, split: Split, caseId: string) =>
  join(root, "recordings", agent, split, `${caseId}.json`);

export function recordedModel(file: string): ModelClient {
  let replay: Promise<ModelClient> | undefined;
  const load = async () => {
    const text = await readFile(file, "utf8").catch(() => {
      throw new Error(
        `no recording at ${file}. Recording one calls a paid provider and needs the maintainer's approval.`,
      );
    });
    return replayModel(ModelCall.array().parse(JSON.parse(text)));
  };
  return {
    async complete(request) {
      replay ??= load();
      return (await replay).complete(request);
    },
  };
}
