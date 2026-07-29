import { describe, expect, it } from "vitest";
import {
  Asset,
  AssetUsageInput,
  AssetInvocationMode,
  AssetLibraryKind,
  CreateAssetInput,
  EditVersionInput,
  CreateGenerationInput,
  GeneratedAsset,
  ExactAssetTransform,
  WatermarkOverlayInput,
} from "../src/index";

describe("Asset taxonomy — V0.0.9", () => {
  it("accepts the platform image and brand-kit library kinds", () => {
    expect(AssetLibraryKind.options).toEqual([
      "MATERIAL",
      "TEMPLATE",
      "GENERATED",
      "BRAND_KIT",
    ]);
  });

  it("defaults new uploaded assets to MATERIAL", () => {
    const parsed = CreateAssetInput.parse({
      workspaceId: "w1",
      category: "OTHER",
      fileName: "logo.png",
      mimeType: "image/png",
      sizeBytes: 128,
      storageKey: "assets/logo.png",
    });

    expect(parsed.libraryKind).toBe("MATERIAL");
  });

  it("serializes libraryKind on asset rows while keeping old rows compatible", () => {
    const base = {
      id: "a1",
      workspaceId: "w1",
      category: "OTHER",
      fileName: "x.png",
      url: "https://example.com/x.png",
      mimeType: "image/png",
      sizeBytes: 1,
      createdAt: new Date(0).toISOString(),
    };

    expect(Asset.safeParse({ ...base, libraryKind: "TEMPLATE" }).success).toBe(
      true,
    );
    expect(Asset.safeParse(base).success).toBe(true);
    expect(Asset.safeParse({ ...base, libraryKind: "BRAND_KIT" }).success).toBe(
      true,
    );
  });

  it("adds project metadata to generated-image library rows", () => {
    const parsed = GeneratedAsset.parse({
      id: "a-generated",
      workspaceId: "w1",
      category: "OTHER",
      libraryKind: "GENERATED",
      fileName: "kv-final.png",
      url: "https://example.com/kv-final.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      createdAt: new Date(0).toISOString(),
      generationVersionId: "gv1",
      generationId: "g1",
      generationCreatedAt: new Date(1).toISOString(),
      projectId: "p1",
      projectName: "夏日新品项目",
      projectStatus: "IN_PROGRESS",
      sceneType: "CAMPAIGN_KV",
    });

    expect(parsed.libraryKind).toBe("GENERATED");
    expect(parsed.projectName).toBe("夏日新品项目");
    expect(parsed.projectStatus).toBe("IN_PROGRESS");
  });
});

describe("Watermark generation contract — V0.0.9", () => {
  it("defines the V0.0.12 invocation modes", () => {
    expect(AssetInvocationMode.options).toEqual([
      "REFERENCE",
      "EXACT",
      "ADAPTIVE",
    ]);
  });

  it("accepts deterministic watermark overlays with defaults", () => {
    const parsed = WatermarkOverlayInput.parse({
      assetId: "asset-1",
      opacity: 0.42,
      widthPx: 180,
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.anchor).toBe("bottom-right");
    expect(parsed.positionMode).toBe("pixel");
    expect(parsed.assetId).toBe("asset-1");
    expect(parsed.invocationMode).toBe("EXACT");
    expect(parsed.lockAspectRatio).toBe(true);
    expect(parsed.allowRecolor).toBe(false);
  });

  it("accepts adaptive invocation overlays", () => {
    const parsed = WatermarkOverlayInput.parse({
      assetId: "asset-1",
      invocationMode: "ADAPTIVE",
      allowRecolor: true,
      lockAspectRatio: true,
    });

    expect(parsed.invocationMode).toBe("ADAPTIVE");
    expect(parsed.allowRecolor).toBe(true);
  });

  it("keeps legacy referenceAssets while adding template refs and watermarks", () => {
    const parsed = CreateGenerationInput.parse({
      projectId: "p1",
      sceneType: "ECOM_MAIN",
      sellingPoint: "summer drink",
      scene: "clean white product poster",
      referenceAssets: [{ assetId: "old-strict", mode: "STRICT" }],
      templateReferenceAssetIds: ["template-1"],
      watermarkOverlays: [
        {
          assetId: "material-logo",
          anchor: "top-left",
          opacity: 0.7,
          widthPx: 120,
        },
      ],
    });

    expect(parsed.referenceAssets?.[0]?.mode).toBe("STRICT");
    expect(parsed.templateReferenceAssetIds).toEqual(["template-1"]);
    expect(parsed.watermarkOverlays?.[0]?.assetId).toBe("material-logo");
    expect(parsed.watermarkOverlays?.[0]?.enabled).toBe(true);
  });

  it("accepts watermark overlays and whole-image edits for V0.0.12", () => {
    const parsed = EditVersionInput.parse({
      op: "IMAGE_EDIT",
      payload: { prompt: "整体增强产品高光" },
      watermarkOverlays: [
        {
          assetId: "material-logo",
          anchor: "top-right",
          opacity: 1,
          widthPx: 180,
        },
      ],
    });

    expect(parsed.watermarkOverlays?.[0]?.assetId).toBe("material-logo");
    expect(parsed.watermarkOverlays?.[0]?.enabled).toBe(true);
  });

  it("rejects invalid watermark geometry and caps overlay count", () => {
    expect(
      WatermarkOverlayInput.safeParse({ assetId: "a1", widthPx: 0 }).success,
    ).toBe(false);

    expect(
      CreateGenerationInput.safeParse({
        projectId: "p1",
        sceneType: "ECOM_MAIN",
        sellingPoint: "x",
        scene: "y",
        watermarkOverlays: Array.from({ length: 9 }, (_, i) => ({
          assetId: `a${i}`,
        })),
      }).success,
    ).toBe(false);
  });
});

describe("Project resource usage — V0.0.21", () => {
  it("defaults identity-locked geometry and allows partial-frame placement", () => {
    const parsed = AssetUsageInput.parse({
      assetId: "chicken-leg",
      mode: "EXACT",
      exactTransform: {
        xRatio: 1.1,
        yRatio: 0.5,
        widthRatio: 0.42,
        rotationDeg: 28,
        crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
      },
    });

    expect(parsed.mode).toBe("EXACT");
    if (parsed.mode !== "EXACT") throw new Error("expected EXACT");
    expect(parsed.exactTransform.flipX).toBe(false);
    expect(parsed.exactTransform.rotationDeg).toBe(28);
    expect(parsed.exactTransform.crop.right).toBe(0.2);
  });

  it("rejects crop settings that erase all visible content", () => {
    expect(
      ExactAssetTransform.safeParse({
        crop: { left: 0.6, right: 0.4, top: 0, bottom: 0 },
      }).success,
    ).toBe(false);
  });

  it("accepts all three explicit generation semantics", () => {
    const common = {
      projectId: "p1",
      sceneType: "ECOM_MAIN",
      assetUsages: [
        { assetId: "a1", mode: "EXACT", order: 0 },
        { assetId: "a2", mode: "ADAPTIVE", order: 1 },
        { assetId: "a3", mode: "REFERENCE", order: 2 },
      ],
    };
    const parsed = CreateGenerationInput.parse(common);
    expect(parsed.assetUsages?.map((usage) => usage.mode)).toEqual([
      "EXACT",
      "ADAPTIVE",
      "REFERENCE",
    ]);
  });
});
