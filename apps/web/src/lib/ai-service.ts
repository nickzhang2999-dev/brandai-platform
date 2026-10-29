import { resolve4 } from "node:dns/promises";

export const REQUIRED_AI_PARSER_REVISION = "grounded-six-slot-r6";
export const REQUIRED_AI_GENERATION_REVISION = "gpt-image-2-size-quality-r1";
export const REQUIRED_AI_VISUAL_CHECK_REVISION = "studio-visual-check-evidence-r1";
export const REQUIRED_AI_PROVIDER_RETRY_REVISION = "single-provider-attempt-r2";
export const REQUIRED_AI_STUDIO_EDIT_REVISION = "studio-whole-image-edit-r1";
export const REQUIRED_AI_STUDIO_IMAGE_TOOLS_REVISION = "studio-image-tools-r1";
export const REQUIRED_AI_STUDIO_DECOMPOSITION_REVISION = "studio-real-layer-single-attempt-r2";
export const REQUIRED_AI_STUDIO_DECOMPOSITION_QUEUE_REVISION = "studio-layer-queue-r2";
export const REQUIRED_AI_STUDIO_LAYER_PLAN_REVISION = "semantic-layer-plan-r2";
export const REQUIRED_AI_STUDIO_CONVERSATION_INTENT_REVISION = "structured-conversation-intent-r2";
export const REQUIRED_AI_STUDIO_WRITING_PARSER_REVISION = "studio-writing-text-v1";

const CONFIGURED_BASE =
  process.env.BRANDAI_AI_SERVICE_URL ??
  process.env.AI_SERVICE_URL ??
  "http://localhost:8000";
const CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

export type AiServiceResolution = {
  base: string;
  source: "configured" | "revision-match";
  parserRevision?: string;
  generationRevision?: string;
  visualCheckRevision?: string;
  providerRetryRevision?: string;
  studioEditRevision?: string;
  studioImageToolsRevision?: string;
  studioDecompositionRevision?: string;
  studioDecompositionQueueRevision?: string;
  studioLayerPlanRevision?: string;
  studioConversationIntentRevision?: string;
  studioWritingParserRevision?: string;
};

export type AiServiceRequirements = { requireVisualCheck?: boolean; requireSingleAttempt?: boolean; requireStudioEdit?: boolean; requireStudioDecomposition?: boolean; requireStudioDecompositionQueue?: boolean; requireStudioLayerPlan?: boolean; requireStudioImageTools?: boolean; requireStudioConversationIntent?: boolean; requireStudioWritingParser?: boolean };

let cachedResolution: { value: AiServiceResolution; expiresAt: number } | null =
  null;

function candidateBase(configured: URL, address: string): string {
  const candidate = new URL(configured.toString());
  candidate.hostname = address;
  return candidate.toString().replace(/\/$/, "");
}

async function probe(base: string): Promise<AiServiceResolution | null> {
  try {
    const response = await fetch(`${base}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      parserRevision?: unknown;
      generationRevision?: unknown;
      visualCheckRevision?: unknown;
      providerRetryRevision?: unknown;
      studioEditRevision?: unknown;
      studioImageToolsRevision?: unknown;
      studioDecompositionRevision?: unknown;
      studioDecompositionQueueRevision?: unknown;
      studioLayerPlanRevision?: unknown;
      studioConversationIntentRevision?: unknown;
      studioWritingParserRevision?: unknown;
    };
    return {
      base,
      source: "revision-match",
      parserRevision:
        typeof body.parserRevision === "string"
          ? body.parserRevision
          : undefined,
      generationRevision:
        typeof body.generationRevision === "string"
          ? body.generationRevision
          : undefined,
      visualCheckRevision:
        typeof body.visualCheckRevision === "string"
          ? body.visualCheckRevision
          : undefined,
      providerRetryRevision: typeof body.providerRetryRevision === "string" ? body.providerRetryRevision : undefined,
      studioEditRevision: typeof body.studioEditRevision === "string" ? body.studioEditRevision : undefined,
      studioImageToolsRevision: typeof body.studioImageToolsRevision === "string" ? body.studioImageToolsRevision : undefined,
      studioDecompositionRevision: typeof body.studioDecompositionRevision === "string" ? body.studioDecompositionRevision : undefined,
      studioDecompositionQueueRevision: typeof body.studioDecompositionQueueRevision === "string" ? body.studioDecompositionQueueRevision : undefined,
      studioLayerPlanRevision: typeof body.studioLayerPlanRevision === "string" ? body.studioLayerPlanRevision : undefined,
      studioConversationIntentRevision: typeof body.studioConversationIntentRevision === "string" ? body.studioConversationIntentRevision : undefined,
      studioWritingParserRevision: typeof body.studioWritingParserRevision === "string" ? body.studioWritingParserRevision : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * CDS historically attached every branch to one Docker network. The bare
 * service alias `ai` can therefore resolve to several branch containers and
 * round-robin into stale code. Resolve every A record and select the service
 * that advertises both parser and image-generation contracts required by this
 * web/worker revision.
 *
 * Explicit non-`ai` URLs remain authoritative for local, production, and
 * operator-managed deployments. Product visual checks additionally require
 * execution-evidence capability, including on an explicit operator URL.
 */
export async function resolveAiService(requirements: AiServiceRequirements = {}): Promise<AiServiceResolution> {
  const now = Date.now();
  const requireVisualCheck = requirements.requireVisualCheck === true;
  const requireStudioEdit = requirements.requireStudioEdit === true;
  const requireStudioImageTools = requirements.requireStudioImageTools === true;
  const requireStudioDecomposition = requirements.requireStudioDecomposition === true;
  const requireStudioDecompositionQueue = requirements.requireStudioDecompositionQueue === true;
  const requireStudioLayerPlan = requirements.requireStudioLayerPlan === true;
  const requireStudioConversationIntent = requirements.requireStudioConversationIntent === true;
  const requireStudioWritingParser = requirements.requireStudioWritingParser === true;
  const requireSingleAttempt = requirements.requireSingleAttempt === true || requireStudioEdit || requireStudioDecomposition || requireStudioDecompositionQueue || requireStudioLayerPlan || requireStudioImageTools || requireStudioConversationIntent;
  if (cachedResolution && cachedResolution.expiresAt > now &&
      (!requireStudioEdit || cachedResolution.value.studioEditRevision === REQUIRED_AI_STUDIO_EDIT_REVISION) &&
      (!requireStudioImageTools || cachedResolution.value.studioImageToolsRevision === REQUIRED_AI_STUDIO_IMAGE_TOOLS_REVISION) &&
      (!requireStudioDecomposition || cachedResolution.value.studioDecompositionRevision === REQUIRED_AI_STUDIO_DECOMPOSITION_REVISION) &&
      (!requireStudioDecompositionQueue || cachedResolution.value.studioDecompositionQueueRevision === REQUIRED_AI_STUDIO_DECOMPOSITION_QUEUE_REVISION) &&
      (!requireStudioLayerPlan || cachedResolution.value.studioLayerPlanRevision === REQUIRED_AI_STUDIO_LAYER_PLAN_REVISION) &&
      (!requireStudioConversationIntent || cachedResolution.value.studioConversationIntentRevision === REQUIRED_AI_STUDIO_CONVERSATION_INTENT_REVISION) &&
      (!requireStudioWritingParser || cachedResolution.value.studioWritingParserRevision === REQUIRED_AI_STUDIO_WRITING_PARSER_REVISION) &&
      (!requireSingleAttempt || cachedResolution.value.providerRetryRevision === REQUIRED_AI_PROVIDER_RETRY_REVISION) &&
      (!requireVisualCheck || cachedResolution.value.visualCheckRevision === REQUIRED_AI_VISUAL_CHECK_REVISION)) {
    return cachedResolution.value;
  }

  const configured = new URL(CONFIGURED_BASE);
  if (configured.hostname !== "ai") {
    const value: AiServiceResolution = {
      base: CONFIGURED_BASE.replace(/\/$/, ""),
      source: "configured",
    };
    if (requireVisualCheck || requireSingleAttempt || requireStudioWritingParser) {
      const health = await probe(value.base);
      if (requireVisualCheck && health?.visualCheckRevision !== REQUIRED_AI_VISUAL_CHECK_REVISION) {
        throw new Error("Configured AI service does not support the required visual-check evidence revision");
      }
      if (requireSingleAttempt && health?.providerRetryRevision !== REQUIRED_AI_PROVIDER_RETRY_REVISION) {
        throw new Error("Configured AI service does not support the required single-provider-attempt revision");
      }
      if (requireStudioEdit && health?.studioEditRevision !== REQUIRED_AI_STUDIO_EDIT_REVISION) {
        throw new Error("Configured AI service does not support the required whole-image-edit revision");
      }
      if (requireStudioImageTools && health?.studioImageToolsRevision !== REQUIRED_AI_STUDIO_IMAGE_TOOLS_REVISION) throw new Error("Configured AI service does not support transparent background and masked image tools");
      if (requireStudioDecomposition && health?.studioDecompositionRevision !== REQUIRED_AI_STUDIO_DECOMPOSITION_REVISION) {
        throw new Error("Configured AI service does not support the required real-layer decomposition revision");
      }
      if (requireStudioDecompositionQueue && health?.studioDecompositionQueueRevision !== REQUIRED_AI_STUDIO_DECOMPOSITION_QUEUE_REVISION) {
        throw new Error("Configured AI service does not support durable layer queue tasks");
      }
      if (requireStudioLayerPlan && health?.studioLayerPlanRevision !== REQUIRED_AI_STUDIO_LAYER_PLAN_REVISION) {
        throw new Error("Configured AI service does not support real semantic-layer planning");
      }
      if (requireStudioConversationIntent && health?.studioConversationIntentRevision !== REQUIRED_AI_STUDIO_CONVERSATION_INTENT_REVISION) throw new Error("Configured AI service does not support structured conversation intent");
      if (requireStudioWritingParser && health?.studioWritingParserRevision !== REQUIRED_AI_STUDIO_WRITING_PARSER_REVISION) throw new Error("Configured AI service does not support bounded writing text parsing");
      Object.assign(value, health, { source: "configured" });
    }
    cachedResolution = { value, expiresAt: now + CACHE_MS };
    return value;
  }

  try {
    const addresses = [...new Set(await resolve4(configured.hostname))].sort();
    const candidates = addresses.map((address) =>
      candidateBase(configured, address),
    );
    const results = await Promise.all(candidates.map(probe));
    const match = results.find(
      (result) =>
        result?.parserRevision === REQUIRED_AI_PARSER_REVISION &&
        result.generationRevision === REQUIRED_AI_GENERATION_REVISION &&
        (!requireStudioEdit || result.studioEditRevision === REQUIRED_AI_STUDIO_EDIT_REVISION) &&
        (!requireStudioImageTools || result.studioImageToolsRevision === REQUIRED_AI_STUDIO_IMAGE_TOOLS_REVISION) &&
        (!requireStudioDecomposition || result.studioDecompositionRevision === REQUIRED_AI_STUDIO_DECOMPOSITION_REVISION) &&
        (!requireStudioDecompositionQueue || result.studioDecompositionQueueRevision === REQUIRED_AI_STUDIO_DECOMPOSITION_QUEUE_REVISION) &&
        (!requireStudioLayerPlan || result.studioLayerPlanRevision === REQUIRED_AI_STUDIO_LAYER_PLAN_REVISION) &&
        (!requireStudioConversationIntent || result.studioConversationIntentRevision === REQUIRED_AI_STUDIO_CONVERSATION_INTENT_REVISION) &&
        (!requireStudioWritingParser || result.studioWritingParserRevision === REQUIRED_AI_STUDIO_WRITING_PARSER_REVISION) &&
        (!requireSingleAttempt || result.providerRetryRevision === REQUIRED_AI_PROVIDER_RETRY_REVISION) &&
        (!requireVisualCheck || result.visualCheckRevision === REQUIRED_AI_VISUAL_CHECK_REVISION),
    );
    if (match) {
      cachedResolution = { value: match, expiresAt: now + CACHE_MS };
      return match;
    }
  } catch (error) {
    throw new Error(
      `AI service discovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Fail closed. Falling back to the shared `ai` alias can round-robin into an
  // older branch and silently return the wrong dimensions/quality. A visible
  // retryable generation failure is safer than persisting a false 3:1 result.
  throw new Error(
    requireStudioDecompositionQueue
      ? "No compatible AI service found for durable layer queue tasks"
      : requireStudioLayerPlan
      ? "No compatible AI service found for real semantic-layer planning"
      : requireStudioDecomposition
      ? "No compatible AI service found for the required real-layer decomposition revision and single-provider-attempt support"
      : requireSingleAttempt
      ? "No compatible AI service found for the required single-provider-attempt revision and requested capabilities"
      : requireVisualCheck
      ? "No compatible AI service found for the required parser, generation and visual-check evidence revisions"
      : "No compatible AI service found for the required parser and generation revisions",
  );
}
