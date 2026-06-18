/**
 * P2.0 — SizeSpec contract + multi-size targets on GenerateRequest, plus the
 * CHANNEL_SIZES preset table that drives the wizard's size picker.
 *
 * Frozen-additive guarantee: `targets` is optional, so omitting it keeps the
 * legacy single-size versionCount path valid (asserted below).
 */
import { describe, expect, it } from "vitest";
import { CHANNEL_SIZES, GenerateRequest, SizeSpec } from "../src/ai";
import { CreateGenerationInput } from "../src/api";

describe("SizeSpec — contract shape", () => {
  it("accepts a valid named size", () => {
    const r = SizeSpec.safeParse({
      key: "xhs_cover",
      label: "小红书封面",
      width: 1080,
      height: 1440,
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-positive / non-integer dimensions", () => {
    expect(
      SizeSpec.safeParse({ key: "k", label: "l", width: 0, height: 100 })
        .success,
    ).toBe(false);
    expect(
      SizeSpec.safeParse({ key: "k", label: "l", width: 10.5, height: 100 })
        .success,
    ).toBe(false);
    expect(
      SizeSpec.safeParse({ key: "k", label: "l", width: -1, height: 100 })
        .success,
    ).toBe(false);
  });

  it("rejects a size missing required keys", () => {
    expect(SizeSpec.safeParse({ width: 100, height: 100 }).success).toBe(
      false,
    );
  });
});

describe("GenerateRequest / CreateGenerationInput — targets", () => {
  const base = {
    sceneType: "ECOM_MAIN" as const,
    sellingPoint: "x",
    scene: "y",
    brandRules: [],
    versionCount: 2,
  };

  it("parses an optional targets array (multi-size path)", () => {
    const r = GenerateRequest.safeParse({
      ...base,
      targets: [
        { key: "ecom_main", label: "电商主图", width: 1024, height: 1024 },
        { key: "banner", label: "Banner", width: 1920, height: 1080 },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.targets).toHaveLength(2);
  });

  it("stays valid with no targets (legacy versionCount path untouched)", () => {
    const r = GenerateRequest.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.success && r.data.targets).toBeUndefined();
  });

  it("CreateGenerationInput accepts optional targets", () => {
    const r = CreateGenerationInput.safeParse({
      projectId: "p1",
      sceneType: "ECOM_MAIN",
      sellingPoint: "x",
      scene: "y",
      versionCount: 1,
      targets: [
        { key: "detail", label: "详情页", width: 750, height: 1000 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects targets with an invalid size entry", () => {
    const r = GenerateRequest.safeParse({
      ...base,
      targets: [{ key: "k", label: "l", width: 0, height: 0 }],
    });
    expect(r.success).toBe(false);
  });
});

describe("CHANNEL_SIZES — preset table", () => {
  it("exposes the documented channel presets with positive integer sizes", () => {
    const keys = CHANNEL_SIZES.map((s) => s.key);
    for (const k of [
      "xhs_cover",
      "ecom_main",
      "detail",
      "moments",
      "banner",
      "campaign_kv",
    ]) {
      expect(keys).toContain(k);
    }
    for (const s of CHANNEL_SIZES) {
      expect(SizeSpec.safeParse(s).success).toBe(true);
    }
  });

  it("matches the documented dimensions for key presets", () => {
    const byKey = Object.fromEntries(CHANNEL_SIZES.map((s) => [s.key, s]));
    expect(byKey.xhs_cover).toMatchObject({ width: 1080, height: 1440 });
    expect(byKey.ecom_main).toMatchObject({ width: 1024, height: 1024 });
    expect(byKey.banner).toMatchObject({ width: 1920, height: 1080 });
  });
});
