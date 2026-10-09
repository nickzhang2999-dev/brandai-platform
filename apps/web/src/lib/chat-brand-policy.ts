import type {
  AIConstraints,
  BrandRule,
  GenerateRequest,
} from "@brandai/contracts";

export interface ChatBrandPolicyInput {
  chatOrigin: boolean;
  brandRules: BrandRule[];
  aiConstraints: AIConstraints;
  /** Product jobs preserve active project prohibitions even without a Brand Kit. */
  preserveCompiledConstraints?: boolean;
}

export interface ChatBrandPolicyResult {
  brandRules: BrandRule[];
  aiConstraints: AIConstraints;
  promptMode?: GenerateRequest["promptMode"];
  mode: "FORM" | "FREE" | "BRANDED";
}

/**
 * Resolve the server-authoritative Brand Kit policy for a generation.
 *
 * There is deliberately no UI input: the active workspace Brand Kit is the
 * authority. Chat without confirmed rules remains a concise free prompt; chat
 * with confirmed rules retains every compiled constraint/reference and uses a
 * compact brand-first prompt mode.
 */
export function resolveChatBrandPolicy({
  chatOrigin,
  brandRules,
  aiConstraints,
  preserveCompiledConstraints = false,
}: ChatBrandPolicyInput): ChatBrandPolicyResult {
  if (!chatOrigin) {
    return { brandRules, aiConstraints, mode: "FORM" };
  }

  if (brandRules.length > 0) {
    return {
      brandRules,
      aiConstraints,
      promptMode: "branded_direct",
      mode: "BRANDED",
    };
  }

  if (preserveCompiledConstraints) {
    return { brandRules: [], aiConstraints, mode: "FREE",
      // The direct AI prompt intentionally omits additions for legacy callers.
      // Product additions (e.g. prohibitions or locked placement) must be used.
      promptMode: aiConstraints.promptAdditions.length ? "branded_direct" : "direct" };
  }

  return {
    brandRules: [],
    aiConstraints: {
      ...aiConstraints,
      promptAdditions: aiConstraints.promptAdditions.filter((addition) =>
        addition.startsWith("[EXACT_LAYOUT]"),
      ),
      referenceImages: aiConstraints.referenceImages.filter((reference) => {
        const note = reference.note ?? "";
        return (
          note.startsWith("IMAGE_INPUT:") || note.startsWith("ASSET_USAGE:")
        );
      }),
    },
    promptMode: "direct",
    mode: "FREE",
  };
}
