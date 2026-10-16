import { prisma } from "@brandai/db";
import {
  ComplianceCheckRequest,
  ComplianceCheckResponse,
  ComplianceReport,
  type ComplianceResult,
} from "@brandai/contracts";
import { ai } from "@/lib/ai";
import { withinAiDeadline, type AiCallOptions } from "./ai-response";

/** Worker-only precheck adapter. Calls the internal AI service once; never self-HTTPs a BFF route. */
export interface PrecheckResult {
  /** false when there is at least one FORBIDDEN finding (must block submit). */
  ok: boolean;
  /** true when blocked by a FORBIDDEN finding (RISK only -> ok stays true). */
  blocking: boolean;
  report: ComplianceReport;
  results: ComplianceResult[];
  /** Wall-clock latency of resolving the precheck through the internal AI service. Used by the worker to write a UsageLog row with
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
    providerRetryPolicy: "never",
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
}, options?: AiCallOptions): Promise<PrecheckResult> {
  const { workspaceId, text } = input;
  const t0 = Date.now();
  const signal = options?.signal ?? AbortSignal.timeout(5 * 60_000);
  const transport = { ...options, signal, maxResponseBytes: Math.min(options?.maxResponseBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024) };
  signal.throwIfAborted();
  const setup = buildDirectRequest(workspaceId, text);
  const request = await withinAiDeadline(setup, signal);
  signal.throwIfAborted();
  const raw = await withinAiDeadline(ai.complianceCheck(request, transport), signal);
  const parsed = ComplianceCheckResponse.parse(raw);
  return {
    ...summarize(parsed.report, parsed.results),
    latencyMs: Date.now() - t0,
  };
}
