import { createStudioBoundedQueue } from "./studio-bounded-queue";
const producer = createStudioBoundedQueue("studio-brand-material-verify");
export async function enqueueStudioBrandMaterial(taskId: string) {
  return producer.run(async (queue, assertCurrent) => {
    assertCurrent();
    await queue.add("verify", { taskId }, { jobId: taskId, attempts: 3,
      backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 3600, count: 1000 } });
  });
}
