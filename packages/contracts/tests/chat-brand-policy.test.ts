import { describe, expect, it } from "vitest";
import type { AIConstraints, BrandRule, VI } from "../src/index";
import { compileAIConstraints } from "../../../apps/web/src/lib/ai-constraints";
import { resolveChatBrandPolicy } from "../../../apps/web/src/lib/chat-brand-policy";

const timestamp = "2026-10-09T00:00:00.000Z";
const prohibition: VI.ProhibitionRule = {
  id: "prohibition-1",
  workspaceId: "workspace-1",
  severity: "MEDIUM",
  status: "ACTIVE",
  affectsGeneration: true,
  affectsValidation: true,
  description: "Do not use the retired packaging treatment",
  alternativeSuggestion: "Use the current pale packaging instead",
  positiveExampleAssetId: "current-packaging",
  negativeExampleAssetId: "retired-packaging",
  scope: [],
  applicableChannels: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};

const confirmedRule: BrandRule = {
  id: "brand-rule-1",
  workspaceId: "workspace-1",
  type: "logo",
  strength: "STRONG",
  status: "CONFIRMED",
  value: {},
  summary: "Use the current logo",
  evidence: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};

function constraints(): AIConstraints {
  const { aiConstraints } = compileAIConstraints([], [prohibition], {
    "current-packaging": "https://assets.example/current.png",
    "retired-packaging": "https://assets.example/retired.png",
  });
  return {
    ...aiConstraints,
    machineRules: { seed: 42, aspect_ratio: "1:1" },
    promptAdditions: [...aiConstraints.promptAdditions, "[EXACT_LAYOUT] Preserve the reserved area"],
    referenceImages: [
      ...aiConstraints.referenceImages,
      { url: "https://assets.example/logo.png", polarity: "positive", mode: "STRICT", source: "brand_rule:logo", note: "BRAND_LOGO_LOCKED: current identity" },
      { url: "https://assets.example/imagery.png", polarity: "positive", mode: "INSPIRATION", source: "brand_rule:imagery", note: "Brand imagery inspiration" },
      { url: "https://assets.example/input.png", polarity: "positive", mode: "STRICT", source: "asset:input", note: "IMAGE_INPUT: explicit source" },
      { url: "https://assets.example/usage.png", polarity: "positive", mode: "INSPIRATION", source: "asset:usage", note: "ASSET_USAGE:REFERENCE: explicit inspiration" },
    ],
  };
}

describe("product chat policy without confirmed Brand Kit rules", () => {
  it("preserves compiled active prohibition examples, negative text, alternatives and every brand reference", () => {
    const input = constraints();
    const result = resolveChatBrandPolicy({ chatOrigin: true, brandRules: [], aiConstraints: input, preserveCompiledConstraints: true });

    expect(result).toEqual({ brandRules: [], aiConstraints: input, mode: "FREE", promptMode: "branded_direct" });
    expect(result.aiConstraints.referenceImages.filter(ref => ref.source === "prohibition:prohibition-1")).toEqual([
      expect.objectContaining({ polarity: "positive", url: "https://assets.example/current.png" }),
      expect.objectContaining({ polarity: "negative", url: "https://assets.example/retired.png" }),
    ]);
    expect(result.aiConstraints.negativePrompt).toContain(prohibition.description);
    expect(result.aiConstraints.promptAdditions).toContain(prohibition.alternativeSuggestion);
    expect(result.aiConstraints.referenceImages).toContainEqual(expect.objectContaining({ source: "brand_rule:logo", mode: "STRICT" }));
    expect(result.aiConstraints.machineRules).toEqual(input.machineRules);
  });

  it("keeps direct prompting when there are no additions without dropping references or negative text", () => {
    const input = { ...constraints(), promptAdditions: [] };
    const result = resolveChatBrandPolicy({ chatOrigin: true, brandRules: [], aiConstraints: input, preserveCompiledConstraints: true });

    expect(result.promptMode).toBe("direct");
    expect(result.mode).toBe("FREE");
    expect(result.aiConstraints).toEqual(input);
    expect(result.aiConstraints.referenceImages).toHaveLength(6);
  });

  it("preserves high-severity hard blocks for the caller instead of erasing them in FREE mode", () => {
    const { aiConstraints } = compileAIConstraints([], [{ ...prohibition, severity: "HIGH" }]);
    const result = resolveChatBrandPolicy({ chatOrigin: true, brandRules: [], aiConstraints, preserveCompiledConstraints: true });

    expect(result.aiConstraints.hardBlocks).toEqual([{ reason: prohibition.description, source: "prohibition:prohibition-1" }]);
    expect(result.aiConstraints).toEqual(aiConstraints);
  });
});

describe("legacy and confirmed-brand policy compatibility", () => {
  it.each([undefined, false])("retains legacy FREE filtering when preserveCompiledConstraints is %s", preserveCompiledConstraints => {
    const input = constraints();
    const before = structuredClone(input);
    const result = resolveChatBrandPolicy({ chatOrigin: true, brandRules: [], aiConstraints: input, ...(preserveCompiledConstraints === undefined ? {} : { preserveCompiledConstraints }) });

    expect(result.mode).toBe("FREE");
    expect(result.promptMode).toBe("direct");
    expect(result.aiConstraints.promptAdditions).toEqual(["[EXACT_LAYOUT] Preserve the reserved area"]);
    expect(result.aiConstraints.referenceImages.map(ref => ref.source)).toEqual(["asset:input", "asset:usage"]);
    expect(result.aiConstraints.negativePrompt).toEqual(input.negativePrompt);
    expect(result.aiConstraints.machineRules).toEqual(input.machineRules);
    expect(input).toEqual(before);
  });

  it.each([undefined, false, true])("retains all confirmed-brand constraints when the opt-in is %s", preserveCompiledConstraints => {
    const input = constraints();
    const result = resolveChatBrandPolicy({ chatOrigin: true, brandRules: [confirmedRule], aiConstraints: input, ...(preserveCompiledConstraints === undefined ? {} : { preserveCompiledConstraints }) });

    expect(result).toEqual({ brandRules: [confirmedRule], aiConstraints: input, mode: "BRANDED", promptMode: "branded_direct" });
  });

  it("does not introduce a chat prompt mode for form-origin generation", () => {
    const input = constraints();
    expect(resolveChatBrandPolicy({ chatOrigin: false, brandRules: [], aiConstraints: input, preserveCompiledConstraints: true })).toEqual({
      brandRules: [], aiConstraints: input, mode: "FORM",
    });
  });
});
