/**
 * Worker entrypoint — `pnpm --filter @brandai/web worker`.
 *
 * Starts every BullMQ worker the web app owns (recognize / parse-manual /
 * generate / edit). The single most important invariant here, learned the
 * hard way on CDS: **this process must not silently exit.** A top-level throw
 * (or an unhandled 'error'/rejection from the shared ioredis connection)
 * exits the container with code 1, the placeholder is already gone, and CDS
 * just shows "stopped" with no stdout — invisible from the API. So we bind a
 * health server FIRST and keep it alive reporting whatever went wrong, which
 * /api/health proxies out for an operator to read.
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRecognizeWorker } from "./recognize.worker";
import { createParseManualWorker } from "./parse-manual.worker";
import { createGenerateWorker } from "./generate.worker";
import { createEditWorker } from "./edit.worker";
import { createDescribeWorker } from "./describe.worker";
import { createIngestWorker } from "./ingest.worker";
import { createSummarizeWorker } from "./summarize.worker";
import { sweepStaleGenerations } from "@/lib/generations";
import {
  REQUIRED_AI_PARSER_REVISION,
  resolveAiService,
  type AiServiceResolution,
} from "@/lib/ai-service";

const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
const workerRevision = "ai-discovery-r1";
const workers: { close: () => Promise<void> }[] = [];
let workersReady = false;
let bootError: string | null = null;
let aiService: AiServiceResolution | null = null;
const execFileAsync = promisify(execFile);

// Bind the health server before constructing anything. Reports:
//   { worker: "starting" }            — port bound, workers not yet created
//   { worker: "ok", count }           — all workers constructed
//   { worker: "error", error, count } — a constructor / runtime error; the
//                                        process stays up so the error is
//                                        visible via /api/health instead of
//                                        an opaque exitCode=1.
http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        worker: bootError ? "error" : workersReady ? "ok" : "starting",
        workerRevision,
        commit: process.env.CDS_COMMIT_SHA?.slice(0, 12) ?? null,
        count: workers.length,
        requiredAiParserRevision: REQUIRED_AI_PARSER_REVISION,
        aiResolution: aiService?.source ?? "checking",
        aiParserRevision: aiService?.parserRevision ?? null,
        ...(bootError ? { error: bootError } : {}),
      }),
    );
  })
  .listen(healthPort, () => {
    console.log(`[workers] health server on :${healthPort}`);
  });

try {
  workers.push(
    createRecognizeWorker(),
    createParseManualWorker(),
    createGenerateWorker(),
    createEditWorker(),
    createDescribeWorker(),
    createIngestWorker(),
    createSummarizeWorker(),
  );
  workersReady = true;
  console.log(`[workers] started: ${workers.length} worker(s)`);
  void resolveAiService()
    .then((resolution) => {
      aiService = resolution;
      console.log(
        `[workers] AI service: ${resolution.source} ${resolution.parserRevision ?? "unknown-revision"}`,
      );
    })
    .catch((error) => {
      console.error("[workers] AI service discovery failed:", error);
    });

  // §2.4 (server side) — sweep orphaned PENDING/RUNNING generations whose
  // BullMQ job died with a previous worker/Redis. Run once on boot, then on
  // an interval, so the queue widget never shows a row that nobody will
  // finish. Best-effort: a sweep failure must not crash the worker.
  const sweep = () =>
    sweepStaleGenerations()
      .then((n) => {
        if (n > 0) console.log(`[sweep] failed ${n} stale generation(s)`);
      })
      .catch((e) => console.error("[sweep] failed:", e));
  void sweep();
  setInterval(sweep, 5 * 60_000).unref();

  // CDS bind-mounts the branch worktree into this long-lived process. A pull
  // can therefore replace source files without recreating the container.
  // Detect that drift and exit cleanly; Docker/CDS restarts the worker so the
  // next job cannot keep executing an older in-memory module graph.
  const deployedCommit = process.env.CDS_COMMIT_SHA;
  if (deployedCommit) {
    setInterval(() => {
      void execFileAsync("git", ["rev-parse", "HEAD"], { cwd: "/app" })
        .then(({ stdout }) => {
          const currentCommit = stdout.trim();
          if (currentCommit && currentCommit !== deployedCommit) {
            console.log(
              `[workers] source changed ${deployedCommit.slice(0, 12)} -> ${currentCommit.slice(0, 12)}; restarting`,
            );
            void shutdown();
          }
        })
        .catch((error) =>
          console.error("[workers] source revision check failed:", error),
        );
    }, 15_000).unref();
  }
} catch (err) {
  bootError = String(err);
  console.error("[workers] FAILED to construct workers:", err);
  // Deliberately do NOT exit — keep the health server up so the cause is
  // observable. CDS readiness already passed (placeholder); a crash here
  // would just produce an invisible stopped container.
}

// The shared ioredis connection emits 'error' on an unreachable/misconfigured
// Redis. An unhandled 'error' event on an EventEmitter throws and crashes the
// process (classic Node footgun) — capture it instead so it surfaces in
// /api/health and the worker stays alive to retry the connection.
process.on("uncaughtException", (err) => {
  bootError = `uncaughtException: ${String(err)}`;
  console.error("[workers] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  bootError = `unhandledRejection: ${String(reason)}`;
  console.error("[workers] unhandledRejection:", reason);
});

async function shutdown() {
  console.log("[workers] shutting down…");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
