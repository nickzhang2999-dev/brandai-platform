import { Queue } from "bullmq";
import IORedis from "ioredis";
import { queuePrefix } from "./queue-prefix";

// A durable Postgres outbox survives Redis unavailability. Never retain an
// unbounded HTTP command on the worker's infinite-retry Redis connection.
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1000,
});
connection.on("error", () => undefined);
export const studioMaterialQueue = new Queue("studio-material-upload", { connection, prefix: queuePrefix, skipWaitingForReady: true });
studioMaterialQueue.on("error", () => undefined);

export async function enqueueStudioMaterial(taskId: string): Promise<boolean> {
  try {
    await studioMaterialQueue.add("upload", { taskId }, {
      jobId: taskId, attempts: 3, backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 3600, count: 1000 },
    });
    return true;
  } catch { return false; }
}
