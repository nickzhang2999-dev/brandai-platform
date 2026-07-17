import { NextResponse } from "next/server";
import { resolveAiService } from "@/lib/ai-service";

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

export async function GET() {
  const aiService = await resolveAiService();
  const aiBase = aiService.base;
  const workerBase = process.env.WORKER_HEALTH_URL ?? "http://worker:3001";
  const [ai, worker] = await Promise.all([
    probe(`${aiBase}/health`),
    probe(workerBase),
  ]);
  return NextResponse.json({
    web: "ok",
    aiBase,
    aiResolution: aiService.source,
    ai: ai.ok ? "ok" : "down",
    aiDetail: ai.body,
    // Pass through the worker's own JSON body when present (it self-reports
    // "ok"/"starting"/"error" with a reason, even on its 503 forensics path);
    // only fall back to "down" when the port is truly unreachable.
    worker: worker.body ?? (worker.ok ? "ok" : "down"),
  });
}
