import { Queue } from "bullmq";
import IORedis from "ioredis";
import { queuePrefix } from "./queue-prefix";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1000,
});
connection.on("error", () => undefined);
export const studioArtifactQueue = new Queue("studio-generation-artifact", { connection, prefix: queuePrefix, skipWaitingForReady: true });
studioArtifactQueue.on("error", () => undefined);

/** Postgres is the outbox. Redis being offline cannot leave HTTP waiting forever. */
export async function enqueueStudioArtifact(outputId: string, expiresAt: Date): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      studioArtifactQueue.add("archive", { outputId, epoch: expiresAt.getTime() }, {
        jobId: `${outputId}-${expiresAt.getTime()}`, attempts: 3, backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true, removeOnFail: true,
      }).then(() => true, () => false),
      new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 1500); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}
