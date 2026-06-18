/**
 * P1.1 — strong-typed VI module schemas. One valid + one invalid case per
 * module, plus discriminated-union round-trip and `extras` forward-compat.
 */
import { describe, it, expect } from "vitest";
import {
  VI,
} from "../src/index";

describe("VI strong-typed modules — valid/invalid per module", () => {
  it("logo valid", () => {
    const r = VI.LogoModule.safeParse({
      module: "logo",
      clear_space_rule: "1x",
      minimum_size: { digital: "24px", print: "8mm" },
      allow_rotation: false,
      logo_dont_rules: ["never stretch", "never recolor"],
    });
    expect(r.success).toBe(true);
  });
  it("logo invalid (wrong discriminator)", () => {
    expect(
      VI.LogoModule.safeParse({ module: "color" }).success,
    ).toBe(false);
  });

  it("color valid", () => {
    const r = VI.ColorModule.safeParse({
      module: "color",
      palette: [
        { name: "primary", hex: "#0a0a0a", usage_priority: "primary" },
      ],
      deviation_threshold: 5,
      allow_gradient: false,
      brightness_preference: "light",
      saturation_preference: "medium",
    });
    expect(r.success).toBe(true);
  });
  it("color invalid (bad hex + out-of-range CMYK)", () => {
    const r = VI.ColorModule.safeParse({
      module: "color",
      palette: [{ hex: "not-a-hex", cmyk: { c: 200 } }],
    });
    expect(r.success).toBe(false);
  });

  it("font valid", () => {
    const r = VI.FontModule.safeParse({
      module: "font",
      primary_font: "Inter",
      fallback_fonts: ["system-ui"],
      license_status: "LICENSED",
      minimum_font_size: { digital: "12px" },
      allow_text_stroke: false,
    });
    expect(r.success).toBe(true);
  });
  it("font invalid (bad license enum)", () => {
    expect(
      VI.FontModule.safeParse({
        module: "font",
        license_status: "BOOTLEG",
      }).success,
    ).toBe(false);
  });

  it("graphic valid", () => {
    expect(
      VI.GraphicModule.safeParse({
        module: "graphic",
        pattern_library: ["wave"],
        allow_decoration: true,
      }).success,
    ).toBe(true);
  });
  it("graphic invalid (non-array pattern_library)", () => {
    expect(
      VI.GraphicModule.safeParse({
        module: "graphic",
        pattern_library: "wave",
      }).success,
    ).toBe(false);
  });

  it("imagery valid", () => {
    expect(
      VI.ImageryModule.safeParse({
        module: "imagery",
        style_keywords: ["editorial", "soft"],
      }).success,
    ).toBe(true);
  });
  it("imagery invalid (wrong type for keywords)", () => {
    expect(
      VI.ImageryModule.safeParse({
        module: "imagery",
        style_keywords: "editorial",
      }).success,
    ).toBe(false);
  });

  it("layout valid", () => {
    expect(
      VI.LayoutModule.safeParse({
        module: "layout",
        alignment_preference: "left",
        whitespace_ratio: 0.4,
      }).success,
    ).toBe(true);
  });
  it("layout invalid (ratio out of range)", () => {
    expect(
      VI.LayoutModule.safeParse({
        module: "layout",
        whitespace_ratio: 2,
      }).success,
    ).toBe(false);
  });

  it("product valid", () => {
    const r = VI.ProductModule.safeParse({
      module: "product",
      standard_angle: ["3/4 front"],
      allow_crop: false,
      allow_tilt: true,
      product_scale_rule: "fills 60% canvas",
    });
    expect(r.success).toBe(true);
  });
  it("product invalid (boolean expected)", () => {
    expect(
      VI.ProductModule.safeParse({
        module: "product",
        allow_crop: "no",
      }).success,
    ).toBe(false);
  });

  it("copy_tone valid", () => {
    expect(
      VI.CopyToneModule.safeParse({
        module: "copy_tone",
        tone_keywords: ["warm", "confident"],
        prohibited_words: ["最", "第一"],
        cta_rule: "verb + benefit",
      }).success,
    ).toBe(true);
  });
  it("copy_tone invalid (wrong shape for prohibited_words)", () => {
    expect(
      VI.CopyToneModule.safeParse({
        module: "copy_tone",
        prohibited_words: "最",
      }).success,
    ).toBe(false);
  });

  it("channel_size valid", () => {
    expect(
      VI.ChannelSizeModule.safeParse({
        module: "channel_size",
        presets: [{ channel: "tmall_main", width: 800, height: 800 }],
      }).success,
    ).toBe(true);
  });
  it("channel_size invalid (missing channel name)", () => {
    expect(
      VI.ChannelSizeModule.safeParse({
        module: "channel_size",
        presets: [{ width: 800 }],
      }).success,
    ).toBe(false);
  });

  it("prohibition valid", () => {
    expect(
      VI.ProhibitionModule.safeParse({
        module: "prohibition",
        rules: [
          {
            severity: "HIGH",
            description: "禁止替换 Logo 颜色",
            scope: ["logo"],
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("prohibition invalid (missing description)", () => {
    expect(
      VI.ProhibitionModule.safeParse({
        module: "prohibition",
        rules: [{ severity: "HIGH" }],
      }).success,
    ).toBe(false);
  });

  it("common_asset valid", () => {
    expect(
      VI.CommonAssetModule.safeParse({
        module: "common_asset",
        entries: [{ assetId: "ast_1", role: "mascot" }],
      }).success,
    ).toBe(true);
  });
  it("common_asset invalid (missing assetId)", () => {
    expect(
      VI.CommonAssetModule.safeParse({
        module: "common_asset",
        entries: [{ role: "mascot" }],
      }).success,
    ).toBe(false);
  });

  it("brand_profile valid", () => {
    expect(
      VI.BrandProfileModule.safeParse({
        module: "brand_profile",
        industry: "F&B",
        brand_personality: ["editorial", "warm"],
      }).success,
    ).toBe(true);
  });
  it("brand_profile invalid (wrong personality shape)", () => {
    expect(
      VI.BrandProfileModule.safeParse({
        module: "brand_profile",
        brand_personality: "warm",
      }).success,
    ).toBe(false);
  });

  it("ai_constraint valid", () => {
    expect(
      VI.AIConstraintModule.safeParse({
        module: "ai_constraint",
        negative_prompt: ["blurry"],
        max_text_length: 80,
        forbid_real_persons: true,
      }).success,
    ).toBe(true);
  });
  it("ai_constraint invalid (negative number for length)", () => {
    expect(
      VI.AIConstraintModule.safeParse({
        module: "ai_constraint",
        max_text_length: -1,
      }).success,
    ).toBe(false);
  });
});

describe("VI discriminated union + extras safety valve", () => {
  it("VIModule.discriminatedUnion parses each variant", () => {
    const samples: unknown[] = [
      { module: "logo" },
      { module: "color" },
      { module: "font" },
      { module: "graphic" },
      { module: "imagery" },
      { module: "layout" },
      { module: "product" },
      { module: "copy_tone" },
      { module: "channel_size" },
      { module: "prohibition" },
      { module: "common_asset" },
      { module: "brand_profile" },
      { module: "ai_constraint" },
    ];
    for (const s of samples) {
      expect(VI.VIModule.safeParse(s).success).toBe(true);
    }
  });

  it("extras passes through unknown forward-compat keys", () => {
    const r = VI.LogoModule.safeParse({
      module: "logo",
      extras: {
        // future field, brand-confirmed P2.x
        responsive_logo_variant: { tablet: "mark-only" },
      },
    });
    expect(r.success).toBe(true);
  });
});
