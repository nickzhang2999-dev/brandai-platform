import { Queue } from "bullmq";
import IORedis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export const connection = new IORedis(url, { maxRetriesPerRequest: null });

/**
 * BullMQ key prefix. CDS gray runs Redis in **shared** mode across branch
 * deployments, and unprefixed queues (`bull:generate`, …) let a foreign/older
 * deployment's worker pick up THIS deployment's jobs — so a stale worker can
 * process a new job and silently drop newly-added job fields. Namespacing the
 * queues per deployment (set `BULLMQ_PREFIX` to the branch/deploy id in the CDS
 * env) keeps each stack's jobs on its own worker. Defaults to BullMQ's standard
 * `"bull"` when unset, so local/single-deploy behavior is unchanged.
 *
 * IMPORTANT: the producer (these Queues) and the consumers
 * (`lib/workers/*.worker.ts`) MUST share this exact prefix.
 */
export const queuePrefix = process.env.BULLMQ_PREFIX || "bull";

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
