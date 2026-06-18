/**
 * P1.2 — AIConstraints contract + compileAIConstraints semantics.
 *
 * Two layers asserted here:
 *  - L2a (contracts): the new optional `aiConstraints` field parses cleanly
 *    on `GenerateRequest`, and the standalone `AIConstraints` schema
 *    requires nothing while keeping the four named keys.
 *  - L2b (compiler): the pure `compileAIConstraints` helper applied to
 *    representative inputs.
 */
import { describe, expect, it } from "vitest";
import { AIConstraints, GenerateRequest, GenerateResponse } from "../src/ai";
import { compileAIConstraints } from "../../../apps/web/src/lib/ai-constraints";
import type { BrandRule, VI } from "../src/index";

function ts(): string {
  return new Date(0).toISOString();
}

function rule(
  partial: Partial<BrandRule> & { type: BrandRule["type"] } & {
    structured?: Record<string, unknown> | null;
  },
): BrandRule & { structured?: Record<string, unknown> | null } {
  return {
    id: partial.id ?? "r1",
    workspaceId: "w1",
    type: partial.type,
    strength: partial.strength ?? "WEAK",
    status: partial.status ?? "CONFIRMED",
    summary: partial.summary ?? "",
    value: partial.value ?? {},
    evidence: partial.evidence ?? [],
    createdAt: ts(),
    updatedAt: ts(),
    structured: partial.structured ?? null,
  };
}

function prohibition(
  partial: Partial<VI.ProhibitionRule> &
    Pick<VI.ProhibitionRule, "severity" | "description">,
): VI.ProhibitionRule {
  return {
    id: partial.id ?? "p1",
    workspaceId: "w1",
    severity: partial.severity,
    affectsGeneration: partial.affectsGeneration ?? true,
    affectsValidation: partial.affectsValidation ?? true,
    description: partial.description,
    scope: partial.scope ?? [],
    applicableChannels: partial.applicableChannels ?? [],
    status: partial.status ?? "ACTIVE",
    createdAt: ts(),
    updatedAt: ts(),
    positiveExampleAssetId: partial.positiveExampleAssetId,
    negativeExampleAssetId: partial.negativeExampleAssetId,
    alternativeSuggestion: partial.alternativeSuggestion,
  };
}

describe("AIConstraints — contract shape", () => {
  it("GenerateRequest accepts optional aiConstraints", () => {
    const r = GenerateRequest.safeParse({
      sceneType: "ECOM_MAIN",
      sellingPoint: "x",
      scene: "y",
      brandRules: [],
      versionCount: 2,
      aiConstraints: {
        negativePrompt: ["no neon"],
        promptAdditions: ["warm"],
        hardBlocks: [],
      },
    });
    expect(r.success).toBe(true);
  });

  it("AIConstraints accepts an empty object (all fields optional/defaulted)", () => {
    expect(AIConstraints.safeParse({}).success).toBe(true);
  });

  it("GenerateResponse.usage is optional and omits null cost/model (T-conn-b)", () => {
    // mock-shaped usage: no costUsd / model keys at all (not null).
    const r = GenerateResponse.safeParse({
      versions: [{ imageUrl: "x", width: 1024, height: 1024, params: {} }],
      usage: { provider: "mock", size: "1024x1024", imageCount: 2, latencyMs: 12 },
    });
    expect(r.success).toBe(true);
    // explicit null on an optional usage field is rejected (null-vs-optional lock)
    const bad = GenerateResponse.safeParse({
      versions: [],
      usage: { provider: "mock", imageCount: 0, costUsd: null },
    });
    expect(bad.success).toBe(false);
    // legacy response without usage still parses
    expect(
      GenerateResponse.safeParse({
        versions: [{ imageUrl: "x", width: 10, height: 10, params: {} }],
      }).success,
    ).toBe(true);
  });
});

describe("compileAIConstraints — semantics", () => {
  it("aggregates STRONG rule summaries into promptAdditions", () => {
    const out = compileAIConstraints(
      [
        rule({
          id: "a",
          type: "color",
          strength: "STRONG",
          summary: "warm palette",
        }),
        rule({
          id: "b",
          type: "layout",
          strength: "WEAK",
          summary: "should-not-appear",
        }),
      ],
      [],
    );
    expect(out.aiConstraints.promptAdditions).toContain("warm palette");
    expect(out.aiConstraints.promptAdditions).not.toContain("should-not-appear");
  });

  it("sorts negativePrompt by prohibition severity (HIGH first)", () => {
    const out = compileAIConstraints(
      [],
      [
        prohibition({ id: "p2", severity: "LOW", description: "low-thing" }),
        prohibition({ id: "p1", severity: "HIGH", description: "high-thing" }),
        prohibition({
          id: "p3",
          severity: "MEDIUM",
          description: "med-thing",
        }),
      ],
    );
    const idx = (s: string) =>
      out.aiConstraints.negativePrompt.findIndex((n) => n.includes(s));
    expect(idx("high-thing")).toBeLessThan(idx("med-thing"));
    expect(idx("med-thing")).toBeLessThan(idx("low-thing"));
  });

  it("caps negativePrompt at 200 entries", () => {
    const many = Array.from({ length: 350 }, (_, i) =>
      prohibition({
        id: `p${i}`,
        severity: "LOW",
        description: `forbid-${i}`,
      }),
    );
    const out = compileAIConstraints([], many);
    expect(out.aiConstraints.negativePrompt.length).toBeLessThanOrEqual(200);
  });

  it("extracts HIGH+affectsGeneration prohibitions into blockers", () => {
    const out = compileAIConstraints(
      [],
      [
        prohibition({
          id: "blk",
          severity: "HIGH",
          description: "no neon",
        }),
        prohibition({
          id: "soft",
          severity: "MEDIUM",
          description: "avoid red",
        }),
        prohibition({
          id: "off",
          severity: "HIGH",
          description: "should-not-block",
          affectsGeneration: false,
        }),
      ],
    );
    expect(out.blockers).toHaveLength(1);
    expect(out.blockers[0]).toMatchObject({
      reason: "no neon",
      source: "prohibition:blk",
    });
  });

  it("compiles prohibition example assets into referenceImages (D5)", () => {
    const out = compileAIConstraints(
      [],
      [
        prohibition({
          id: "p1",
          severity: "MEDIUM",
          description: "禁止低对比 logo",
          positiveExampleAssetId: "good1",
          negativeExampleAssetId: "bad1",
        }),
        prohibition({
          // example id present but the asset url is unresolved → skipped.
          id: "p2",
          severity: "LOW",
          description: "no example url",
          positiveExampleAssetId: "missing",
        }),
      ],
      { good1: "https://cdn/good1.png", bad1: "https://cdn/bad1.png" },
    );
    expect(out.aiConstraints.referenceImages).toEqual([
      {
        url: "https://cdn/good1.png",
        polarity: "positive",
        source: "prohibition:p1",
        note: "禁止低对比 logo",
      },
      {
        url: "https://cdn/bad1.png",
        polarity: "negative",
        source: "prohibition:p1",
        note: "禁止低对比 logo",
      },
    ]);
  });

  it("emits an empty referenceImages list when no example assets resolve", () => {
    const out = compileAIConstraints([], []);
    expect(out.aiConstraints.referenceImages).toEqual([]);
  });

  it("falls back to structured.extras for cfg/seed/aspect_ratio (extras bridge)", () => {
    const out = compileAIConstraints(
      [
        rule({
          id: "lay",
          type: "layout",
          strength: "STRONG",
          structured: {
            module: "layout",
            extras: { aspect_ratio: "16:9", cfg: 7, seed: 42 },
          },
        }),
      ],
      [],
    );
    expect(out.aiConstraints.machineRules).toMatchObject({
      aspect_ratio: "16:9",
      cfg: 7,
      seed: 42,
    });
  });
});
