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
import { createRecognizeWorker } from "./recognize.worker";
import { createParseManualWorker } from "./parse-manual.worker";
import { createGenerateWorker } from "./generate.worker";
import { createEditWorker } from "./edit.worker";
import { createDescribeWorker } from "./describe.worker";
import { sweepStaleGenerations } from "@/lib/generations";

const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
const workers: { close: () => Promise<void> }[] = [];
let workersReady = false;
let bootError: string | null = null;

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
        count: workers.length,
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
  );
  workersReady = true;
  console.log(`[workers] started: ${workers.length} worker(s)`);

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
