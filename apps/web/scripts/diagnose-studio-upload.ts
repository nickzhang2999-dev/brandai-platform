/** Failure evidence only: no queue mutation, provider calls, raw log lines or
 * configuration values. Only run against the disposable loopback CI stack. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, open, writeFile } from "node:fs/promises";
import path from "node:path";

const knownErrors: Array<[string, RegExp]> = [
  ["redis-offline-queue", /Stream isn't writeable and enableOfflineQueue options is false/i],
  ["redis-command-timeout", /Command timed out|commandTimeout/i],
  ["connection-refused", /ECONNREFUSED/], ["connection-reset", /ECONNRESET/],
  ["connection-timeout", /ETIMEDOUT|TimeoutError|AbortError/],
  ["redis-max-retries", /MaxRetriesPerRequestError/],
  ["prisma-query", /PrismaClientKnownRequestError|PrismaClientUnknownRequestError/],
  ["prisma-startup", /PrismaClientInitializationError/],
  ["storage-access-denied", /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/],
  ["storage-bucket-missing", /NoSuchBucket/],
  ["worker-lock", /Missing lock for job|Lock mismatch|stalled more than/],
];
const knownCodes = /\b(?:P100[0-9]|P101[0-9]|P200[0-9]|P201[0-9]|P202[0-9]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/g;
function classify(value: unknown) {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return { categories: knownErrors.filter(([, pattern]) => pattern.test(text)).map(([label]) => label), codes: [...new Set(text.match(knownCodes) ?? [])].sort() };
}
function summarizeLog(text: string) {
  const lines = text.split(/\r?\n/), counts: Record<string, number> = {};
  for (const line of lines) for (const label of classify(line).categories) counts[label] = (counts[label] ?? 0) + 1;
  const events: Record<string, number> = {};
  for (const [label, pattern] of [
    ["worker-health-bound", /\[workers\] health server on/], ["workers-constructed", /\[workers\] started:/],
    ["worker-construction-failed", /\[workers\] FAILED to construct/], ["worker-unhandled-rejection", /\[workers\] unhandledRejection/],
    ["worker-uncaught-exception", /\[workers\] uncaughtException/], ["upload-outbox-sweep-failed", /\[studio-upload\] outbox sweep unavailable/],
    ["upload-job-failed", /\[studio-upload\] task .* retry or failure recorded/],
    ["stored-secret-decrypt-failed", /\[ai-settings\] a stored secret failed to decrypt/],
    ["next-server-ready", /Ready in \d|✓ Ready/],
  ] as const) events[label] = lines.filter(line => pattern.test(line)).length;
  return { linesRead: lines.length, events, errorCategoryCounts: counts, codes: classify(text).codes };
}
async function logSummary(filename?: string) {
  if (!filename) return { available: false };
  try {
    // Bounded tail in memory; raw logs never enter the artifact directory.
    const info = await stat(filename), size = Math.min(info.size, 256 * 1024), handle = await open(filename, "r");
    try { const buffer = Buffer.alloc(size); const read = await handle.read(buffer, 0, size, Math.max(0, info.size - size));
      return { available: true, tailOnly: info.size > size, ...summarizeLog(buffer.subarray(0, read.bytesRead).toString("utf8")) }; }
    finally { await handle.close(); }
  } catch { return { available: false }; }
}
function safeUiDiagnostic(value: unknown) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const requests = Array.isArray(raw.requests) ? raw.requests : [];
  const allowedPaths = new Set(["/studio/material-upload", "/studio/draft", "/studio/generation", "/workflow", "/workflow/assets", "/compare/api/create", "/studio-editor"]);
  return {
    available: !!value, error: classify(raw.error), browserErrorCount: Array.isArray(raw.browserErrors) ? raw.browserErrors.length : 0,
    unexpectedNetworkCount: Array.isArray(raw.networkProblems) ? raw.networkProblems.length : 0,
    // No step names, user content, dynamic IDs, URLs, queries or error messages.
    requests: requests.slice(-50).map(item => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { path: typeof row.path === "string" && allowedPaths.has(row.path) ? row.path : "other",
        method: ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(row.method)) ? row.method : "other",
        status: typeof row.status === "number" && row.status >= 100 && row.status < 600 ? row.status : null };
    }),
  };
}
const token = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
function option(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const deadline = <T>(promise: Promise<T>, ms = 5000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TimeoutError")), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

async function collect() {
  const app = new URL(process.env.WORKBENCH_TEST_URL ?? "http://127.0.0.1:3000");
  const db = new URL(process.env.DATABASE_URL ?? "http://invalid"), redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  if (process.env.CI !== "true" || db.pathname !== "/novart_integration_test" || ![app, db, redisUrl].every(url => ["localhost", "127.0.0.1"].includes(url.hostname))
    || !["3000", "3100"].includes(app.port) || redisUrl.protocol !== "redis:") throw new Error("Disposable CI loopback guard rejected diagnostics");
  const directory = path.resolve(".novart-ui-artifacts", "port-" + app.port);
  const report: Record<string, unknown> = { diagnosticOnly: true, acceptancePassed: false, port: Number(app.port), collectedAt: new Date().toISOString() };
  let prisma: import("@brandai/db").PrismaClient | undefined;
  let redis: import("ioredis").default | undefined;
  let queue: import("bullmq").Queue | undefined;
  // The outer shell also bounds this command. Never print unfiltered thrown
  // objects: database/SDK error messages can contain inputs or credentials.
  try {
    const [{ PrismaClient }, { default: IORedis }, { Queue }, { queuePrefix }] = await Promise.all([
      import("@brandai/db"), import("ioredis"), import("bullmq"), import("../src/lib/queue-prefix"),
    ]);
    prisma = new PrismaClient({ log: [] });
    let rows: Array<{ taskId: string; attemptToken: string | null; expiresAt: Date; sizeBytes: number; assetId: string | null;
      task: { status: string; progress: number; updatedAt: Date } }> = [];
    try {
      rows = await deadline(prisma.studioMaterialUpload.findMany({ where: { task: { status: { in: ["PENDING", "RUNNING", "FAILED"] } } },
        select: { taskId: true, attemptToken: true, expiresAt: true, sizeBytes: true, assetId: true,
          task: { select: { status: true, progress: true, updatedAt: true } } }, orderBy: { createdAt: "desc" }, take: 12 }));
      report.database = { readable: true, limit: 12 };
    } catch (error) { report.database = { readable: false, error: classify(error) }; }
    report.uploads = rows.map(row => ({ task: token(row.taskId), status: row.task.status, progress: row.task.progress,
      claimPresent: !!row.attemptToken, assetPresent: !!row.assetId, sizeBytes: row.sizeBytes,
      expired: row.expiresAt.getTime() <= Date.now(), lastUpdateAgeMs: Math.max(0, Date.now() - row.task.updatedAt.getTime()) }));
    redis = new IORedis(redisUrl.href, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 2000, retryStrategy: () => null });
    redis.on("error", () => undefined);
    try {
      await deadline(redis.connect()); const pong = await deadline(redis.ping());
      report.redis = { connected: redis.status === "ready", pingOk: pong === "PONG" };
      queue = new Queue("studio-material-upload", { connection: redis, prefix: queuePrefix, skipMetasUpdate: true }); queue.on("error", () => undefined);
      await deadline(queue.waitUntilReady());
      report.queue = { ready: true, counts: await deadline(queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused")), workerCount: (await deadline(queue.getWorkers())).length };
      const jobs = [];
      for (const row of rows) {
        const job = await deadline(queue.getJob(row.taskId));
        jobs.push({ task: token(row.taskId), present: !!job, ...(job ? { state: await deadline(job.getState()), attemptsMade: job.attemptsMade,
          processed: !!job.processedOn, finished: !!job.finishedOn, failure: classify(job.failedReason) } : {}) });
      }
      report.jobs = jobs;
    } catch (error) { report.redisOrQueueError = classify(error); report.redis ??= { connected: redis.status === "ready", pingOk: false }; }
    try {
      const response = await fetch("http://127.0.0.1:3001/health", { signal: AbortSignal.timeout(3000) }); const health = await response.json();
      report.workerHealth = { available: response.ok, worker: ["starting", "ok", "error"].includes(health.worker) ? health.worker : "unknown",
        count: typeof health.count === "number" ? health.count : null, queuePrefixMatches: health.queuePrefix === queuePrefix, error: classify(health.error) };
    } catch (error) { report.workerHealth = { available: false, error: classify(error) }; }
  } catch (error) { report.collectionError = classify(error); }
  finally {
    await deadline(queue?.close() ?? Promise.resolve(), 2000).catch(() => undefined); redis?.disconnect();
    await deadline(prisma?.$disconnect() ?? Promise.resolve(), 2000).catch(() => undefined);
    report.serverLog = await logSummary(option("--server-log")); report.workerLog = await logSummary(option("--worker-log"));
    try { report.ui = safeUiDiagnostic(JSON.parse(await readFile(path.join(directory, "diagnostics.json"), "utf8"))); }
    catch { report.ui = { available: false }; }
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "failure-runtime.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}

if (process.argv.includes("--self-test")) {
  const privateText = "private-user-text", secret = "fake-secret-canary";
  const raw = `AUTH_SECRET=${secret} Authorization: Bearer ${secret}\nPOST https://example.invalid/path?token=${secret}\n${privateText}\n[workers] started: 12 worker(s)\nError: Stream isn't writeable and enableOfflineQueue options is false\nPrismaClientKnownRequestError P2028 ${privateText}`;
  const summary = summarizeLog(raw); assert.equal(summary.events["workers-constructed"], 1); assert.equal(summary.errorCategoryCounts["redis-offline-queue"], 1);
  assert.deepEqual(summary.codes, ["P2028"]);
  const ui = safeUiDiagnostic({ error: raw, step: privateText, browserErrors: [raw], networkProblems: [raw], requests: [{ path: "/studio/material-upload", method: "POST", status: 202 }, { path: `/secret?token=${secret}`, method: privateText, status: 400 }] });
  const output = JSON.stringify({ summary, ui }); for (const hidden of [privateText, secret, "Authorization", "example.invalid", "token=", "AUTH_SECRET"]) assert.ok(!output.includes(hidden));
  assert.equal(ui.requests[1]?.path, "other"); assert.equal(token("fixture-task").length, 12);
  console.log("PASS failure diagnostics preserve useful categories and discard secrets, URLs, headers and user text");
} else {
  const guard = setTimeout(() => { console.error("Failure diagnostics reached their 30-second collection bound"); process.exit(1); }, 30000); guard.unref();
  await collect().catch(() => { console.error("Failure diagnostics could not complete; no raw error or configuration emitted"); process.exitCode = 1; }).finally(() => clearTimeout(guard));
}
