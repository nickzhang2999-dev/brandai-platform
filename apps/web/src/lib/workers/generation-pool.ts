import { setTimeout as delay } from "node:timers/promises";
import type { Queue } from "bullmq";

function positiveLimit(name: string, value: string, max: number): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return Number(value);
}

export function generationPoolSettings(env: NodeJS.ProcessEnv = process.env) {
  const role = env.DF_WORKER_ROLE ?? "all";
  if (role !== "all" && role !== "generate") throw new Error("Unknown DF_WORKER_ROLE");
  const local = positiveLimit("DF_GENERATE_CONCURRENCY", env.DF_GENERATE_CONCURRENCY ?? "2", 8);
  const global = env.DF_GENERATE_GLOBAL_CONCURRENCY === undefined ? null :
    positiveLimit("DF_GENERATE_GLOBAL_CONCURRENCY", env.DF_GENERATE_GLOBAL_CONCURRENCY, 64);
  if (global === null && (role === "generate" || local > 2)) {
    throw new Error("Set DF_GENERATE_GLOBAL_CONCURRENCY before scaling image workers");
  }
  return { role, local, global } as const;
}

// Only the primary changes the shared BullMQ limit. Replicas may start before it.
export async function prepareGenerationPool(
  queue: Pick<Queue, "getGlobalConcurrency" | "setGlobalConcurrency">,
  settings: ReturnType<typeof generationPoolSettings>,
  signal: AbortSignal,
) {
  if (settings.global === null) return;
  if (settings.role === "all") {
    await queue.setGlobalConcurrency(settings.global);
    return;
  }
  while (!signal.aborted && await queue.getGlobalConcurrency() !== settings.global) {
    await delay(1000, undefined, { signal });
  }
}
