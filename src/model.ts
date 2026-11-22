import { z } from "zod";

export const ModelCall = z.object({
  request: z.unknown(),
  response: z.unknown(),
  duration_ms: z.number().nonnegative(),
  cost_usd: z.number().nonnegative(),
});
export type ModelCall = z.infer<typeof ModelCall>;

export type ModelClient = {
  complete(request: unknown): Promise<Omit<ModelCall, "request">>;
};

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
