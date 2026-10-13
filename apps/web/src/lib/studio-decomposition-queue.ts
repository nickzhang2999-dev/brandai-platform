import { createStudioBoundedQueue } from "./studio-bounded-queue";

const producer = createStudioBoundedQueue("studio-decomposition");

/** Only the authoritative PENDING/private-archive outbox may call this helper.
 * A terminal Redis delivery can be replaced without resetting the durable
 * provider claim, so queue recovery never authorizes a second paid request. */
export async function enqueueStudioDecomposition(requestId: string): Promise<boolean> {
  return producer.run(async (queue, assertCurrent) => {
    const old = await queue.getJob(requestId);
    assertCurrent();
    if (old) {
      const state = await old.getState();
      assertCurrent();
      if (["completed", "failed"].includes(state)) {
        await old.remove();
        assertCurrent();
      }
    }
    await queue.add("decompose", { requestId }, {
      jobId: requestId, attempts: 1,
      removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 86400, count: 1000 },
    });
  });
}
