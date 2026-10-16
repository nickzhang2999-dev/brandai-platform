import { createStudioBoundedQueue } from "./studio-bounded-queue";

const producer = createStudioBoundedQueue("compliance-task");

/** Postgres is the durable outbox; a Redis outage never loses accepted work. */
export function enqueueComplianceTask(taskId: string, jobId: string) {
  return producer.run(async (queue, assertCurrent) => {
    assertCurrent();
    await queue.add("check", { taskId, jobId }, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true });
  });
}
