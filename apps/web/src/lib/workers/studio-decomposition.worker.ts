import { Worker } from "bullmq";
import { connection, queuePrefix } from "@/lib/queue";
import { dispatchStudioDecompositions, runStudioDecomposition } from "@/lib/studio-decomposition";

export async function runStudioDecompositionJob(job: { data: { requestId: string } }) {
  await runStudioDecomposition(job.data.requestId);
}

export function createStudioDecompositionWorker() {
  const worker = new Worker("studio-decomposition", runStudioDecompositionJob, {
    connection, prefix: queuePrefix, concurrency: 1,
  });
  let sweeping = false;
  let closed = false;
  const sweep = () => {
    if (closed || sweeping) return;
    sweeping = true;
    void dispatchStudioDecompositions()
      .catch(() => console.warn("[studio-decomposition] recovery pending"))
      .finally(() => { sweeping = false; });
  };
  sweep();
  const interval = setInterval(sweep, 15_000);
  interval.unref();
  worker.on("closed", () => { closed = true; clearInterval(interval); });
  worker.on("failed", () => console.warn("[studio-decomposition] task awaits recovery or explicit retry"));
  worker.on("error", () => console.warn("[studio-decomposition] worker temporarily unavailable"));
  return worker;
}
