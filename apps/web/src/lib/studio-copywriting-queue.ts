import { createStudioBoundedQueue } from "./studio-bounded-queue";
const producer = createStudioBoundedQueue("studio-copywriting");
export function enqueueStudioCopywriting(taskId: string, name: "write" | "sol-poster-brief" = "write") {
  return producer.run(async (queue, current) => { current(); await queue.add(name, { taskId }, { jobId: taskId, attempts: 1, removeOnComplete: true, removeOnFail: true }); });
}
