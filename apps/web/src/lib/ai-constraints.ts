/**
 * P1.2 — AI constraint compiler.
 *
 * Takes the workspace's CONFIRMED `BrandRule` library plus its ACTIVE
 * `ProhibitionRule` rows and produces a `AIConstraints` payload the worker
 * passes through to the AI service, plus an out-of-band `blockers` list the
 * worker uses to short-circuit HIGH-severity prohibitions before any provider
 * call.
 *
 * Pure / side-effect free so unit tests can exercise every branch.
 *
 * Feature flag: `process.env.AI_CONSTRAINTS_V1` (default "1"). Setting it to
 * "0" makes the worker skip both injection and hard-block enforcement and
 * fall back to the legacy P0 path (summary-only prompt).
 */
import type {
  AIConstraints,
  BrandRule,
  ReferenceImage,
  VI,
} from "@brandai/contracts";

/** Soft cap on tokens (approx by word count) for negativePrompt. */
const NEGATIVE_PROMPT_MAX = 200;

const STRENGTH_PRIORITY: Record<string, number> = {
  FORBIDDEN: 0,
  STRONG: 1,
  WEAK: 2,
};

type RuleWithStructured = BrandRule & {
  structured?: Record<string, unknown> | null;
};

export interface CompileResult {
  aiConstraints: AIConstraints;
  /**
   * Hard blocks that must abort the generation: HIGH-severity active
   * prohibitions AND CONFIRMED brand rules with strength === "FORBIDDEN".
   */
  blockers: Array<{ reason: string; source: string }>;
}

/**
 * Compile confirmed rules + active prohibitions into a wire-shaped
 * `AIConstraints` payload.
 *
 * Empty-on-empty: passing no rules / no prohibitions returns a valid payload
 * with empty arrays — callers should use the `blockers` length to decide
 * whether to short-circuit.
 */
export function compileAIConstraints(
  rules: RuleWithStructured[],
  prohibitions: VI.ProhibitionRule[],
  /**
   * D5 — map of `assetId → fetchable URL` for the prohibition example assets.
   * The caller resolves the IDs (worker/route) so this stays pure. Missing ids
   * are skipped (a deleted asset simply contributes no reference image).
   */
  assetUrls: Record<string, string> = {},
): CompileResult {
  const negativePrompt: string[] = [];
  const promptAdditions: string[] = [];
  const machineRules: Record<string, unknown> = {};
  const referenceImages: ReferenceImage[] = [];

  // 1) Prohibitions → negativePrompt (and HIGH/affectsGeneration → blockers)
  const activeProhibitions = prohibitions.filter(
    (p) => p.status === "ACTIVE" && p.affectsGeneration,
  );

  // D5 — resolve each active prohibition's positive/negative example asset into
  // a ReferenceImage the AI service can fetch. The rule description rides along
  // as `note` so the provider/VLM has context for what the example illustrates.
  for (const p of activeProhibitions) {
    const note = p.description?.trim() || undefined;
    const posUrl = p.positiveExampleAssetId
      ? assetUrls[p.positiveExampleAssetId]
      : undefined;
    if (posUrl) {
      referenceImages.push({
        url: posUrl,
        polarity: "positive",
        source: `prohibition:${p.id}`,
        ...(note ? { note } : {}),
      });
    }
    const negUrl = p.negativeExampleAssetId
      ? assetUrls[p.negativeExampleAssetId]
      : undefined;
    if (negUrl) {
      referenceImages.push({
        url: negUrl,
        polarity: "negative",
        source: `prohibition:${p.id}`,
        ...(note ? { note } : {}),
      });
    }
  }
  const blockers: Array<{ reason: string; source: string }> = activeProhibitions
    .filter((p) => p.severity === "HIGH")
    .map((p) => ({ reason: p.description, source: `prohibition:${p.id}` }));

  // CONFIRMED + FORBIDDEN brand rules become hard-blocks only when they
  // describe a *visual* prohibition (forbidden imagery / competing logos /
  // disallowed graphic motifs). Copy/font/layout guidelines flagged FORBIDDEN
  // are advisory — they shape the generator via negativePrompt below but
  // shouldn't gate the whole workspace (otherwise a single "禁止使用复杂或长句"
  // rule blocks every generation regardless of input). De-duped by source.
  const HARD_BLOCK_RULE_TYPES = new Set(["imagery", "graphic", "logo"]);
  const blockerSources = new Set(blockers.map((b) => b.source));
  for (const rule of rules) {
    if (rule.status !== "CONFIRMED" || rule.strength !== "FORBIDDEN") continue;
    if (!HARD_BLOCK_RULE_TYPES.has(rule.type)) continue;
    const source = `brand_rule:${rule.id}`;
    if (blockerSources.has(source)) continue;
    blockerSources.add(source);
    const reason =
      (rule.summary && rule.summary.trim()) ||
      `品牌规范禁用项（${rule.type}）`;
    blockers.push({ reason, source });
  }

  // Sort by severity (HIGH > MEDIUM > LOW) — drives priority into the
  // negativePrompt truncation below.
  const sevOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const sevWeight = (s: string): number => sevOrder[s] ?? 9;
  const orderedProhibitions = [...activeProhibitions].sort(
    (a, b) => sevWeight(a.severity) - sevWeight(b.severity),
  );
  for (const p of orderedProhibitions) {
    if (p.description) negativePrompt.push(p.description);
    if (p.alternativeSuggestion) promptAdditions.push(p.alternativeSuggestion);
  }

  // 2) Brand rules → negativePrompt + promptAdditions + machineRules
  const sortedRules = [...rules].sort(
    (a, b) =>
      (STRENGTH_PRIORITY[a.strength] ?? 9) -
      (STRENGTH_PRIORITY[b.strength] ?? 9),
  );

  for (const rule of sortedRules) {
    const structured = (rule.structured ?? null) as
      | Record<string, unknown>
      | null;

    // copy_tone.prohibited_words → negative
    if (rule.type === "copy" && structured) {
      const pw = structured.prohibited_words;
      if (Array.isArray(pw)) {
        for (const w of pw) {
          if (typeof w === "string" && w) negativePrompt.push(w);
        }
      }
      const preferred = structured.preferred_words;
      if (rule.strength === "STRONG" && Array.isArray(preferred)) {
        const head = preferred.filter((x) => typeof x === "string").slice(0, 5);
        if (head.length) {
          promptAdditions.push(`preferred tone: ${head.join(", ")}`);
        }
      }
    }

    // color.prohibited_combinations → negative
    if (rule.type === "color" && structured) {
      const combos = structured.prohibited_combinations;
      if (Array.isArray(combos)) {
        for (const c of combos) {
          if (Array.isArray(c) && c.length) {
            negativePrompt.push(
              `avoid color combination: ${c
                .filter((x) => typeof x === "string")
                .join(" + ")}`,
            );
          }
        }
      }
      // recommended palette → promptAdditions when STRONG
      if (rule.strength === "STRONG" && Array.isArray(structured.palette)) {
        const hexes = (structured.palette as Array<Record<string, unknown>>)
          .map((s) => (typeof s.hex === "string" ? s.hex : null))
          .filter((h): h is string => !!h)
          .slice(0, 6);
        if (hexes.length) {
          promptAdditions.push(`brand palette: ${hexes.join(", ")}`);
        }
      }
    }

    // FORBIDDEN/STRONG summaries → soft additions
    if (rule.strength === "STRONG" || rule.strength === "FORBIDDEN") {
      if (rule.summary) promptAdditions.push(rule.summary);
    }
    if (rule.strength === "FORBIDDEN" && rule.summary) {
      negativePrompt.push(rule.summary);
    }

    // layout → machineRules.aspect_ratio (best-effort)
    if (rule.type === "layout" && structured && !machineRules.aspect_ratio) {
      const ar =
        structured.aspect_ratio ??
        (structured.extras as Record<string, unknown> | undefined)
          ?.aspect_ratio;
      if (typeof ar === "string") machineRules.aspect_ratio = ar;
    }

    // extras.cfg / extras.seed bubble-up (best-effort)
    if (structured) {
      const extras = structured.extras as Record<string, unknown> | undefined;
      if (extras) {
        if (extras.cfg !== undefined && machineRules.cfg === undefined) {
          machineRules.cfg = extras.cfg;
        }
        if (extras.seed !== undefined && machineRules.seed === undefined) {
          machineRules.seed = extras.seed;
        }
      }
    }
  }

  // De-dup negativePrompt while preserving priority order, then truncate
  // to NEGATIVE_PROMPT_MAX entries (each entry treated as one "token bucket"
  // — strict word counting belongs to the provider).
  const seen = new Set<string>();
  const dedupedNegative: string[] = [];
  for (const n of negativePrompt) {
    const key = n.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedupedNegative.push(n);
    if (dedupedNegative.length >= NEGATIVE_PROMPT_MAX) break;
  }

  // De-dup promptAdditions identically.
  const seenAdd = new Set<string>();
  const dedupedAdds: string[] = [];
  for (const a of promptAdditions) {
    const key = a.trim().toLowerCase();
    if (!key || seenAdd.has(key)) continue;
    seenAdd.add(key);
    dedupedAdds.push(a);
  }

  return {
    aiConstraints: {
      machineRules:
        Object.keys(machineRules).length > 0 ? machineRules : undefined,
      promptAdditions: dedupedAdds,
      negativePrompt: dedupedNegative,
      hardBlocks: blockers,
      referenceImages,
    },
    blockers,
  };
}

/** Feature-flag predicate; defaults to enabled. */
export function constraintsEnabled(): boolean {
  return (process.env.AI_CONSTRAINTS_V1 ?? "1") !== "0";
}

export const __test = { NEGATIVE_PROMPT_MAX };
