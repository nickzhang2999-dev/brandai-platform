import { createStudioBoundedQueue } from "./studio-bounded-queue";
import type { GenerateJobData } from "./workers/generate.worker";
const producer = createStudioBoundedQueue("generate");
export async function enqueueStudioGeneration(requestId: string, data: GenerateJobData): Promise<boolean> {
  return producer.run(async (queue, assertCurrent) => {
    // A pre-provider DB conflict can complete/fail the Bull job while its
    // durable receipt is still PENDING. Callers only dispatch unclaimed rows.
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
    await queue.add("studio-generate", data, { jobId: requestId, attempts: 1,
      removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } });
  });
}
