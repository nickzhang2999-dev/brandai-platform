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
import { resolveChatBrandPolicy } from "../../../apps/web/src/lib/chat-brand-policy";
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

  it("GenerateRequest accepts branded_direct for automatic Brand Kit chat", () => {
    expect(
      GenerateRequest.safeParse({
        sceneType: "ECOM_MAIN",
        sellingPoint: "客厅餐桌电商海报",
        scene: "",
        brandRules: [],
        versionCount: 1,
        promptMode: "branded_direct",
      }).success,
    ).toBe(true);
  });

  it("AIConstraints accepts an empty object (all fields optional/defaulted)", () => {
    expect(AIConstraints.safeParse({}).success).toBe(true);
  });

  it("GenerateResponse.usage is optional and omits null cost/model (T-conn-b)", () => {
    // mock-shaped usage: no costUsd / model keys at all (not null).
    const r = GenerateResponse.safeParse({
      versions: [{ imageUrl: "x", width: 1024, height: 1024, params: {} }],
      usage: {
        provider: "mock",
        size: "1024x1024",
        imageCount: 2,
        latencyMs: 12,
      },
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

describe("chat Brand Kit policy", () => {
  const logoRule = rule({
    id: "logo-rule",
    type: "logo",
    strength: "STRONG",
    summary: "必须使用品牌主 Logo",
  });

  it("retains compiled constraints and the automatic logo for branded chat", () => {
    const policy = resolveChatBrandPolicy({
      chatOrigin: true,
      brandRules: [logoRule],
      aiConstraints: AIConstraints.parse({
        promptAdditions: ["品牌主色 #FF6C2C"],
        referenceImages: [
          {
            url: "https://cdn/brand-logo.png",
            polarity: "positive",
            source: "brand_rule:logo-rule",
            mode: "STRICT",
            note: "BRAND_LOGO_LOCKED: authoritative logo",
          },
        ],
      }),
    });

    expect(policy.mode).toBe("BRANDED");
    expect(policy.promptMode).toBe("branded_direct");
    expect(policy.brandRules.map((item) => item.id)).toEqual(["logo-rule"]);
    expect(policy.aiConstraints.promptAdditions).toEqual(["品牌主色 #FF6C2C"]);
    expect(policy.aiConstraints.referenceImages[0]?.note).toMatch(
      /^BRAND_LOGO_LOCKED:/,
    );
  });

  it("keeps free chat concise when the active kit has no confirmed rules", () => {
    const policy = resolveChatBrandPolicy({
      chatOrigin: true,
      brandRules: [],
      aiConstraints: AIConstraints.parse({
        promptAdditions: ["unrelated brand dump"],
        negativePrompt: ["禁止违法内容"],
        referenceImages: [
          {
            url: "https://cdn/style.png",
            polarity: "positive",
            source: "brand_rule:r1",
          },
          {
            url: "https://cdn/user.png",
            polarity: "positive",
            source: "asset:a1",
            mode: "STRICT",
            note: "IMAGE_INPUT:1",
          },
        ],
      }),
    });

    expect(policy.mode).toBe("FREE");
    expect(policy.promptMode).toBe("direct");
    expect(policy.brandRules).toEqual([]);
    expect(policy.aiConstraints.promptAdditions).toEqual([]);
    expect(policy.aiConstraints.negativePrompt).toEqual(["禁止违法内容"]);
    expect(policy.aiConstraints.referenceImages).toHaveLength(1);
    expect(policy.aiConstraints.referenceImages[0]?.note).toBe("IMAGE_INPUT:1");
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
    expect(out.aiConstraints.promptAdditions).not.toContain(
      "should-not-appear",
    );
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

  it("does NOT hard-block on a FORBIDDEN logo guideline, but still steers the generator (docs/10 #3)", () => {
    const out = compileAIConstraints(
      [
        rule({
          id: "logo-safe-area",
          type: "logo",
          strength: "FORBIDDEN",
          status: "CONFIRMED",
          summary: "Logo 周围保留不少于 1x 高度的安全留白",
        }),
      ],
      [],
    );
    // a logo *usage guideline* must never gate the whole brand …
    expect(out.blockers).toHaveLength(0);
    // … yet its guidance is preserved (folded into prompt + negativePrompt).
    expect(out.aiConstraints.promptAdditions).toContain(
      "Logo 周围保留不少于 1x 高度的安全留白",
    );
    expect(out.aiConstraints.negativePrompt).toContain(
      "Logo 周围保留不少于 1x 高度的安全留白",
    );
  });

  it("NEVER hard-blocks on FORBIDDEN brand rules — imagery/graphic included (V0.0.13, 二次复发根治)", () => {
    // 2026-07-17 用户实测：一条「不允许使用旧logo」的 FORBIDDEN 品牌规范
    // （存成 imagery/graphic 型）把该品牌**所有**出图无条件 422 拦死——与
    // docs/10 #3 的 logo 规则事故同类，只是换了个 type 复发。根治：文字型
    // 品牌规范系统无法逐次判定是否真被违反，一律不做全局生成闸门；其约束
    // 仍进 negativePrompt + promptAdditions 约束模型。真正的「禁止生成」
    // 语义只保留给显式的 ProhibitionRule（HIGH + affectsGeneration）。
    const out = compileAIConstraints(
      [
        rule({
          id: "no-old-logo",
          type: "imagery",
          strength: "FORBIDDEN",
          status: "CONFIRMED",
          summary: "不允许使用旧logo",
        }),
        rule({
          id: "no-motif",
          type: "graphic",
          strength: "FORBIDDEN",
          status: "CONFIRMED",
          summary: "禁止使用竞品图形母题",
        }),
      ],
      [],
    );
    expect(out.blockers).toHaveLength(0);
    // 约束不丢：折入 negative prompt + additions 继续钳制模型。
    expect(out.aiConstraints.negativePrompt).toContain("不允许使用旧logo");
    expect(out.aiConstraints.negativePrompt).toContain("禁止使用竞品图形母题");
    expect(out.aiConstraints.promptAdditions).toContain("不允许使用旧logo");
  });

  it("keeps ProhibitionRule HIGH as the only hard-block channel", () => {
    const out = compileAIConstraints(
      [
        rule({
          id: "no-old-logo",
          type: "imagery",
          strength: "FORBIDDEN",
          status: "CONFIRMED",
          summary: "不允许使用旧logo",
        }),
      ],
      [
        prohibition({
          id: "blk",
          severity: "HIGH",
          description: "禁止生成含酒精内容",
        }),
      ],
    );
    expect(out.blockers).toEqual([
      { reason: "禁止生成含酒精内容", source: "prohibition:blk" },
    ]);
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
