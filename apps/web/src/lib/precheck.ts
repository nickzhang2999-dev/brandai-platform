import { prisma } from "@brandai/db";
import {
  ComplianceCheckRequest,
  ComplianceCheckResponse,
  ComplianceReport,
  type ComplianceResult,
} from "@brandai/contracts";
import { ai } from "@/lib/ai";

/**
 * Pre-generation compliance precheck adapter (M3 calls this before enqueuing
 * a generation; M5 will later own the real endpoint).
 *
 * ## Stable contract M5 must honor
 *
 * M3 only ever calls `runPrecheck({ workspaceId, text })` and consumes the
 * returned `PrecheckResult`. The adapter resolves the check in this order:
 *
 *  1. If `POST /api/workspaces/{workspaceId}/compliance/precheck` exists
 *     (M5 will own it), POST `{ workspaceId, text }` (the frozen
 *     `PrecheckInput` body) and expect a `ComplianceCheckResponse`
 *     (`{ results, report }`, frozen contract).
 *  2. Otherwise fall back to calling the AI service directly via
 *     `ai.complianceCheck({ text, termLib: <ComplianceTerm rows>, brandRules: [] })`.
 *
 * **Invariant for M5:** keep the route at that path accepting `PrecheckInput`
 * and returning `ComplianceCheckResponse`. As long as that holds, M5 can take
 * over the endpoint without any change to this file or the wizard. The
 * `PrecheckResult` shape below (`{ ok, blocking, report, results }`) is what
 * the wizard renders — keep it stable for any future consumers.
 */
export interface PrecheckResult {
  /** false when there is at least one FORBIDDEN finding (must block submit). */
  ok: boolean;
  /** true when blocked by a FORBIDDEN finding (RISK only -> ok stays true). */
  blocking: boolean;
  report: ComplianceReport;
  results: ComplianceResult[];
  /** Wall-clock latency of resolving the precheck (either via the M5 route or
   *  the direct AI call). Used by the worker to write a UsageLog row with
   *  kind=COMPLIANCE so the activity log shows AI-side time for prechecks too.
   *  Optional so existing callers (the standalone advisory route) can ignore
   *  it without ceremony. */
  latencyMs?: number;
}

function summarize(
  report: ComplianceReport,
  results: ComplianceResult[],
): PrecheckResult {
  const all = [
    ...results,
    ...report.textResults,
    ...report.visualResults,
  ];
  const blocking =
    report.overall === "FORBIDDEN" ||
    all.some((r) => r.level === "FORBIDDEN");
  return { ok: !blocking, blocking, report, results };
}

/** Build the AI request from the workspace's compliance term library. */
async function buildDirectRequest(
  workspaceId: string,
  text: string,
): Promise<ComplianceCheckRequest> {
  const terms = await prisma.complianceTerm.findMany({
    where: { workspaceId },
    select: { type: true, term: true, reason: true, replacement: true },
  });
  return ComplianceCheckRequest.parse({
    text,
    brandRules: [],
    termLib: terms.map((t) => ({
      type: t.type,
      term: t.term,
      reason: t.reason,
      replacement: t.replacement ?? undefined,
    })),
  });
}

/**
 * Run the pre-generation compliance precheck for a piece of selling-point
 * copy. Never throws on a "found risks" outcome — only on infrastructure
 * failure; callers should treat a thrown error as "could not precheck".
 */
export async function runPrecheck(input: {
  workspaceId: string;
  text: string;
  /** Absolute base url, so the server can self-call the (M5) route. */
  baseUrl?: string;
}): Promise<PrecheckResult> {
  const { workspaceId, text } = input;
  const t0 = Date.now();

  // 1. Prefer the M5-owned endpoint if it is wired up.
  if (input.baseUrl) {
    try {
      const res = await fetch(
        `${input.baseUrl}/api/workspaces/${workspaceId}/compliance/precheck`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, text }),
          cache: "no-store",
        },
      );
      if (res.ok) {
        const parsed = ComplianceCheckResponse.parse(await res.json());
        return {
          ...summarize(parsed.report, parsed.results),
          latencyMs: Date.now() - t0,
        };
      }
      // 404/501 -> M5 not built yet, fall through to the direct AI call.
    } catch {
      /* network/route error -> fall through to direct AI call */
    }
  }

  // 2. Fallback: call the AI compliance check directly through the adapter.
  const request = await buildDirectRequest(workspaceId, text);
  const raw = await ai.complianceCheck(request);
  const parsed = ComplianceCheckResponse.parse(raw);
  return {
    ...summarize(parsed.report, parsed.results),
    latencyMs: Date.now() - t0,
  };
}
