import { createStudioBoundedQueue } from "./studio-bounded-queue";
const producer = createStudioBoundedQueue("studio-copywriting");
export function enqueueStudioCopywriting(taskId: string) {
  return producer.run(async (queue, current) => { current(); await queue.add("write", { taskId }, { jobId: taskId, attempts: 1, removeOnComplete: true, removeOnFail: true }); });
}
