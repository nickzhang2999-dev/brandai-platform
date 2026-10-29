import { Worker } from "bullmq";
import { prisma } from "@brandai/db";
import { connection, queuePrefix } from "../queue";
import { createStudioBoundedQueue } from "../studio-bounded-queue";
import { WRITING_KIND, expireWriting } from "../studio-writing";
import { processWritingTask } from "../studio-writing-runtime";

const producer = createStudioBoundedQueue("studio-writing");
export async function dispatchStudioWriting() {
  await expireWriting();
  const rows = await prisma.asyncTask.findMany({ where: { kind: WRITING_KIND, status: "PENDING", expiresAt: { gt: new Date() } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 30 });
  await Promise.all(rows.map(row => producer.run(async (queue, current) => { current(); await queue.add("process", { taskId: row.id }, { jobId: row.id, attempts: 1, removeOnComplete: true, removeOnFail: true }); })));
}
export function createStudioWritingWorker() {
  const worker = new Worker("studio-writing", job => processWritingTask(job.data.taskId), { connection, prefix: queuePrefix, concurrency: 2 });
  let busy = false;
  const dispatch = () => { if (busy) return; busy = true; void dispatchStudioWriting().catch(() => console.warn("[writing] outbox unavailable")).finally(() => { busy = false; }); };
  dispatch(); const timer = setInterval(dispatch, 3000); timer.unref();
  worker.on("closed", () => { clearInterval(timer); producer.close(); });
  worker.on("failed", () => console.warn("[writing] task interrupted; no automatic model retry"));
  return worker;
}
