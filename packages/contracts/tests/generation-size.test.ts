import { describe, expect, it } from "vitest";
import {
  DEFAULT_GENERATION_SIZE_SELECTION,
  GENERATION_ASPECT_RATIO_PRESETS,
  GenerationSizeSelection,
  generationQualityForTier,
  resolveGenerationSize,
  validateGptImage2Size,
} from "../src";

describe("workbench generation size matrix", () => {
  it("exposes exactly 12 ratios and 24 valid 1K/2K combinations", () => {
    expect(GENERATION_ASPECT_RATIO_PRESETS).toHaveLength(12);
    expect(
      new Set(GENERATION_ASPECT_RATIO_PRESETS.map((item) => item.key)).size,
    ).toBe(12);

    for (const preset of GENERATION_ASPECT_RATIO_PRESETS) {
      const oneK = preset.sizes["1K"];
      const twoK = preset.sizes["2K"];
      expect(validateGptImage2Size(oneK.width, oneK.height)).toBeNull();
      expect(validateGptImage2Size(twoK.width, twoK.height)).toBeNull();
      expect(twoK.width).toBe(oneK.width * 2);
      expect(twoK.height).toBe(oneK.height * 2);

      for (const tier of ["1K", "2K"] as const) {
        const resolved = resolveGenerationSize({
          ratioKey: preset.key,
          resolutionTier: tier,
        });
        expect(resolved).toMatchObject({
          ratioKey: preset.key,
          resolutionTier: tier,
          width: preset.sizes[tier].width,
          height: preset.sizes[tier].height,
        });
      }
    }
  });

  it("defaults to 1:1 1K and maps quality separately from pixels", () => {
    expect(DEFAULT_GENERATION_SIZE_SELECTION).toEqual({
      ratioKey: "1:1",
      resolutionTier: "1K",
    });
    expect(generationQualityForTier("1K")).toBe("medium");
    expect(generationQualityForTier("2K")).toBe("high");
  });
});

describe("custom gpt-image-2 ratios", () => {
  it("resolves a custom ratio to API-valid 1K pixels and exactly doubles for 2K", () => {
    const oneK = resolveGenerationSize({
      ratioKey: "custom",
      resolutionTier: "1K",
      customRatio: { width: 7, height: 5 },
    });
    const twoK = resolveGenerationSize({
      ratioKey: "custom",
      resolutionTier: "2K",
      customRatio: { width: 7, height: 5 },
    });

    expect(oneK.ratioKey).toBe("custom");
    expect(oneK.requestedRatio).toBe("7:5");
    expect(validateGptImage2Size(oneK.width, oneK.height)).toBeNull();
    expect(validateGptImage2Size(twoK.width, twoK.height)).toBeNull();
    expect(twoK.width).toBe(oneK.width * 2);
    expect(twoK.height).toBe(oneK.height * 2);
    expect(oneK.width / oneK.height).toBeCloseTo(7 / 5, 2);
  });

  it("accepts the inclusive 1:3–3:1 boundary and rejects values outside it", () => {
    for (const customRatio of [
      { width: 1, height: 3 },
      { width: 3, height: 1 },
    ]) {
      expect(
        GenerationSizeSelection.safeParse({
          ratioKey: "custom",
          resolutionTier: "1K",
          customRatio,
        }).success,
      ).toBe(true);
    }
    expect(
      GenerationSizeSelection.safeParse({
        ratioKey: "custom",
        resolutionTier: "1K",
        customRatio: { width: 4, height: 1 },
      }).success,
    ).toBe(false);
    expect(
      GenerationSizeSelection.safeParse({
        ratioKey: "custom",
        resolutionTier: "1K",
      }).success,
    ).toBe(false);
  });
});
