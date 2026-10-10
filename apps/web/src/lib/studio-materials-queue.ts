import { createStudioBoundedQueue } from "./studio-bounded-queue";

// A durable Postgres outbox survives Redis unavailability. Never retain an
// unbounded HTTP command on the worker's infinite-retry Redis connection.
const producer = createStudioBoundedQueue("studio-material-upload");

export async function enqueueStudioMaterial(taskId: string): Promise<boolean> {
  return producer.run(async (queue, assertCurrent) => {
    assertCurrent();
    await queue.add("upload", { taskId }, {
      jobId: taskId, attempts: 3, backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 3600, count: 1000 },
    });
  });
}
