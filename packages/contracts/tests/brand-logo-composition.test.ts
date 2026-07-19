import { describe, expect, it } from "vitest";
import { applyWatermarksToImage } from "../../../apps/web/src/lib/watermark";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

describe("automatic Brand Kit logo composition", () => {
  it("composites the authoritative logo bytes and records the asset id", async () => {
    const base = svgDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#ffffff"/></svg>',
    );
    const logo = svgDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#FF6C2C"/></svg>',
    );

    const result = await applyWatermarksToImage(base, [
      {
        assetId: "brand-logo-1",
        assetUrl: logo,
        assetMimeType: "image/svg+xml",
        enabled: true,
        anchor: "top-left",
        positionMode: "ratio",
        offsetX: 0.05,
        offsetY: 0.05,
        widthPx: 120,
        opacity: 1,
        fontFamily: "Inter",
        fontSizePx: 20,
        textColor: "#111827",
        backgroundEnabled: false,
        backgroundColor: "#FFFFFF",
        borderEnabled: false,
        borderColor: "#7C5CFF",
        borderWidth: 1,
        cornerRadius: 0,
      },
    ]);

    expect(result.appliedAssetIds).toEqual(["brand-logo-1"]);
    expect(result.imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(
      Buffer.from(result.imageUrl.split(",")[1] ?? "", "base64").length,
    ).toBeGreaterThan(100);
  });
});
