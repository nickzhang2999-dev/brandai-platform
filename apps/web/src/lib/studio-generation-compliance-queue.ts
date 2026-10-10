import { createStudioBoundedQueue } from "./studio-bounded-queue";
const producer = createStudioBoundedQueue("studio-generation-compliance");

/** The task row is the outbox. A queue outage never erases an accepted check. */
export async function enqueueStudioCompliance(taskId: string, jobId: string): Promise<boolean> {
  return producer.run(async (queue, assertCurrent) => {
    assertCurrent();
    await queue.add("check", { taskId, jobId }, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true });
  });
}
