import { Queue } from "bullmq";
import IORedis from "ioredis";
import { queuePrefix } from "@/lib/queue-prefix";

export { queuePrefix } from "@/lib/queue-prefix";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export const connection = new IORedis(url, { maxRetriesPerRequest: null });

// Preview production is best-effort: cache-miss GETs will retry and generation
// results remain authoritative without it. Do not put these adds on the
// worker-grade infinite-retry connection; during a Redis outage every browser
// retry would otherwise retain another command until reconnection.
const imagePreviewProducerConnection = new IORedis(url, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
imagePreviewProducerConnection.on("error", () => undefined);

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
export const editQueue = new Queue("edit", {
  connection,
  prefix: queuePrefix,
});
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
// 画布缩略图涉及对象存储读取 + Sharp 转码，必须在 worker 里完成；GET 只鉴权、
// 读取已生成的小图，缺失时入队后快速返回。
export const imagePreviewQueue = new Queue("image-preview", {
  connection: imagePreviewProducerConnection,
  prefix: queuePrefix,
});

const IMAGE_PREVIEW_ENQUEUE_TIMEOUT_MS = 1_000;
const inFlightImagePreviewAdds = new Map<string, Promise<boolean>>();

/**
 * Cache-miss image GETs must remain bounded even when Redis is unavailable.
 * The preview producer also disables the offline queue, so a timed-out request
 * cannot leave a retained Redis command behind. The browser's retryable 202
 * will make a later request try the same idempotent job ID again.
 */
export async function enqueueImagePreview(
  data: { workspaceId: string; versionId?: string; assetId?: string },
): Promise<boolean> {
  const jobId = data.versionId
    ? `version-${data.versionId}`
    : `asset-${data.assetId}`;
  let enqueue = inFlightImagePreviewAdds.get(jobId);
  if (!enqueue) {
    enqueue = imagePreviewQueue
      .add("build", data, {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      })
      .then(() => true)
      .catch((error) => {
        console.error(`[image-preview] enqueue ${jobId} failed:`, error);
        return false;
      })
      .finally(() => {
        inFlightImagePreviewAdds.delete(jobId);
      });
    inFlightImagePreviewAdds.set(jobId, enqueue);
  }

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), IMAGE_PREVIEW_ENQUEUE_TIMEOUT_MS);
  });
  const queued = await Promise.race([enqueue, timedOut]);
  if (timer) clearTimeout(timer);
  if (!queued) {
    console.warn(
      `[image-preview] enqueue ${jobId} unavailable after ${IMAGE_PREVIEW_ENQUEUE_TIMEOUT_MS}ms; client will retry`,
    );
  }
  return queued;
}
