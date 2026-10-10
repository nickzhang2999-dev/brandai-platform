import { createStudioBoundedQueue } from "./studio-bounded-queue";
const producer = createStudioBoundedQueue("studio-generation-artifact");

/** Postgres is the outbox. Redis being offline cannot leave HTTP waiting forever. */
export async function enqueueStudioArtifact(outputId: string, expiresAt: Date): Promise<boolean> {
  return producer.run(async (queue, assertCurrent) => {
    assertCurrent();
    await queue.add("archive", { outputId, epoch: expiresAt.getTime() }, {
      jobId: `${outputId}-${expiresAt.getTime()}`, attempts: 3, backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: true, removeOnFail: true,
    });
  });
}
