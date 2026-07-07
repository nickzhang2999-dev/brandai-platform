import { describe, expect, it } from "vitest";
import {
  Asset,
  AssetLibraryKind,
  CreateAssetInput,
  CreateGenerationInput,
  WatermarkOverlayInput,
} from "../src/index";

describe("Asset taxonomy — V0.0.9", () => {
  it("accepts the three platform image library kinds", () => {
    expect(AssetLibraryKind.options).toEqual([
      "MATERIAL",
      "TEMPLATE",
      "GENERATED",
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
      false,
    );
  });
});

describe("Watermark generation contract — V0.0.9", () => {
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
