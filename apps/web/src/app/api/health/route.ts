import { NextResponse } from "next/server";
import { resolve4 } from "node:dns/promises";
import { resolveAiService } from "@/lib/ai-service";
import { queuePrefix } from "@/lib/queue-prefix";

const REQUIRED_WORKER_REVISION = "ai-discovery-r2";

// Server-internal health aggregation. CDS doesn't route worker:3001 publicly
// (it's health-only) so we proxy a TCP+HTTP probe through here. This is the
// only way an external operator can tell whether BullMQ workers actually
// loaded (workersReady) vs sitting in a stuck placeholder.
async function probe(url: string): Promise<{ ok: boolean; body?: unknown }> {
  try {
    const r = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    // Surface the body even on non-2xx — the worker's forensics/boot-error
    // server replies 503 with a diagnostic JSON we want to pass through, not
    // collapse to a bare "down".
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      /* non-JSON body */
    }
    return { ok: r.ok, body };
  } catch {
    return { ok: false };
  }
}

async function resolveWorkerHealth(base: string) {
  const configured = new URL(base);
  if (configured.hostname !== "worker") return probe(base);
  try {
    const addresses = [...new Set(await resolve4(configured.hostname))].sort();
    const probes = await Promise.all(
      addresses.map(async (address) => {
        const candidate = new URL(configured.toString());
        candidate.hostname = address;
        return probe(candidate.toString().replace(/\/$/, ""));
      }),
    );
    const matching = probes.find((result) => {
      if (!result.ok || !result.body || typeof result.body !== "object") {
        return false;
      }
      const body = result.body as Record<string, unknown>;
      return (
        body.workerRevision === REQUIRED_WORKER_REVISION &&
        body.queuePrefix === queuePrefix
      );
    });
    return matching ?? probes.find((result) => result.ok) ?? { ok: false };
  } catch {
    return probe(base);
  }
}

export async function GET() {
  const aiService = await resolveAiService();
  const aiBase = aiService.base;
  const workerBase = process.env.WORKER_HEALTH_URL ?? "http://worker:3001";
  const [ai, worker] = await Promise.all([
    probe(`${aiBase}/health`),
    resolveWorkerHealth(workerBase),
  ]);
  return NextResponse.json({
    web: "ok",
    aiBase,
    aiResolution: aiService.source,
    ai: ai.ok ? "ok" : "down",
    aiDetail: ai.body,
    queuePrefix,
    // Pass through the worker's own JSON body when present (it self-reports
    // "ok"/"starting"/"error" with a reason, even on its 503 forensics path);
    // only fall back to "down" when the port is truly unreachable.
    worker: worker.body ?? (worker.ok ? "ok" : "down"),
  });
}
