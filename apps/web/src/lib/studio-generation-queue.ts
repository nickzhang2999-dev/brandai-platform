import { Queue } from "bullmq";
import IORedis from "ioredis";
import { queuePrefix } from "./queue-prefix";
import type { GenerateJobData } from "./workers/generate.worker";
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1000,
});
connection.on("error", () => undefined);
const queue = new Queue("generate", { connection, prefix: queuePrefix, skipWaitingForReady: true });
queue.on("error", () => undefined);
export async function enqueueStudioGeneration(requestId: string, data: GenerateJobData): Promise<boolean> {
  try {
    // A pre-provider DB conflict can complete/fail the Bull job while its
    // durable receipt is still PENDING. Callers only dispatch unclaimed rows.
    const old = await queue.getJob(requestId);
    if (old && ["completed", "failed"].includes(await old.getState())) await old.remove();
    await queue.add("studio-generate", data, { jobId: requestId, attempts: 1,
      removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } });
    return true;
  } catch { return false; }
}
