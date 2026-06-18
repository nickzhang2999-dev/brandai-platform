import { prisma } from "@brandai/db";
import {
  ComplianceCheckRequest,
  ComplianceCheckResponse,
} from "@brandai/contracts";
import { ai } from "@/lib/ai";
import { loadProhibitionReferenceImages } from "@/lib/prohibitions";

/**
 * M5 server-side compliance helpers.
 *
 * The single source of truth for turning a workspace's `ComplianceTerm`
 * rows into the `termLib` the AI service expects, and for running a
 * text/visual compliance check through the frozen AI contract. Used by:
 *  - `POST /api/workspaces/[wsId]/compliance/precheck` (M3 pre-generation
 *    precheck — must return a `ComplianceCheckResponse`).
 *  - the post-generation recheck route (text + visual, persisted into
 *    `GenerationVersion.complianceReport`).
 *
 * The AI mock provider keeps this deterministic with zero keys.
 */

/** Load the workspace's compliance term library as the AI `termLib`. */
export async function loadTermLib(workspaceId: string) {
  const terms = await prisma.complianceTerm.findMany({
    where: { workspaceId },
    select: { type: true, term: true, reason: true, replacement: true },
    orderBy: { createdAt: "desc" },
  });
  return terms.map((t) => ({
    type: t.type,
    term: t.term,
    reason: t.reason,
    replacement: t.replacement ?? undefined,
  }));
}

/**
 * Run a compliance check (text and/or image) for a workspace. Loads the
 * workspace's term library, calls the AI service through the frozen
 * contract and re-validates the response. Never throws on a "found risks"
 * outcome — only on infrastructure failure.
 */
export async function runComplianceCheck(input: {
  workspaceId: string;
  text?: string;
  imageUrl?: string;
}): Promise<ComplianceCheckResponse> {
  const termLib = await loadTermLib(input.workspaceId);
  // D5 — only an image check benefits from visual example references; skip the
  // extra query for text-only prechecks.
  const referenceImages = input.imageUrl
    ? await loadProhibitionReferenceImages(input.workspaceId, "validation")
    : [];
  const request = ComplianceCheckRequest.parse({
    text: input.text,
    imageUrl: input.imageUrl,
    brandRules: [],
    termLib,
    referenceImages,
  });
  const raw = await ai.complianceCheck(request);
  return ComplianceCheckResponse.parse(raw);
}
