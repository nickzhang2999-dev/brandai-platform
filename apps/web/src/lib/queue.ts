import { Queue } from "bullmq";
import IORedis from "ioredis";
import { queuePrefix } from "@/lib/queue-prefix";

export { queuePrefix } from "@/lib/queue-prefix";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export const connection = new IORedis(url, { maxRetriesPerRequest: null });

/**
 * BullMQ key prefix. CDS injects VITE_GIT_BRANCH into every app container, so
 * derive the namespace in code instead of relying on an operator to remember a
 * branch-scoped BULLMQ_PREFIX. This prevents another branch's older worker from
 * consuming a new parse/generate job on the shared Redis instance.
 *
 * BRANDAI_QUEUE_PREFIX remains the explicit production override. The legacy
 * BULLMQ_PREFIX is used only when no branch identity exists (local/single-stack
 * compatibility). Producer and consumers import this same constant.
 */
export const recognizeQueue = new Queue("recognize", {
  connection,
  prefix: queuePrefix,
});
export const parseManualQueue = new Queue("parse-manual", {
  connection,
  prefix: queuePrefix,
});
export const generateQueue = new Queue("generate", {
  connection,
  prefix: queuePrefix,
});
export const editQueue = new Queue("edit", { connection, prefix: queuePrefix });
// E9/E10 — asset auto-tagging (describe). Same prefix convention as the others.
export const describeQueue = new Queue("describe", {
  connection,
  prefix: queuePrefix,
});
// K3 / §2 — website ingest crawl (moved out of the HTTP handler). Same prefix
// convention as the others.
export const ingestQueue = new Queue("ingest", {
  connection,
  prefix: queuePrefix,
});
// B2/C8 / §2 — text summarization (brief decompose / campaign summary). The VLM
// chat call is slow → runs in a worker. Same prefix convention as the others.
export const summarizeQueue = new Queue("summarize", {
  connection,
  prefix: queuePrefix,
});
// 图层分解(AI 分层)。一次调用产 N 张图层,耗时 12-42 秒 —— 与其它慢调用同样
// 走 worker,前缀约定一致。concurrency 压到 1:每个 job 自己就要拉 N 张图回来
// 做实墨包围盒计算,并发叠加会把 worker 容器的内存打满。
export const decomposeQueue = new Queue("decompose", {
  connection,
  prefix: queuePrefix,
});
