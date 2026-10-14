import { createStudioBoundedQueue } from "./studio-bounded-queue";
const producer = createStudioBoundedQueue("studio-conversation");
export function enqueueStudioConversation(messageId: string) {
  return producer.run(async (queue, assertCurrent) => {
    const previous = await queue.getJob(messageId); assertCurrent();
    if (previous && ["completed", "failed"].includes(await previous.getState())) { await previous.remove(); assertCurrent(); }
    await queue.add("conversation", { messageId }, { jobId: messageId, attempts: 1, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } });
  });
}
