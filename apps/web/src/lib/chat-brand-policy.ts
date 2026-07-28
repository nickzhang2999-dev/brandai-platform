import type {
  AIConstraints,
  BrandRule,
  GenerateRequest,
} from "@brandai/contracts";

export interface ChatBrandPolicyInput {
  chatOrigin: boolean;
  brandRules: BrandRule[];
  aiConstraints: AIConstraints;
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
