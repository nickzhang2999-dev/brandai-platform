import { Queue } from "bullmq";
import IORedis from "ioredis";
import { queuePrefix } from "./queue-prefix";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1000,
});
connection.on("error", () => undefined);
const queue = new Queue("studio-generation-compliance", { connection, prefix: queuePrefix, skipWaitingForReady: true });
queue.on("error", () => undefined);

/** The task row is the outbox. A queue outage never erases an accepted check. */
export async function enqueueStudioCompliance(taskId: string, jobId: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      queue.add("check", { taskId, jobId }, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true }).then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1500); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
