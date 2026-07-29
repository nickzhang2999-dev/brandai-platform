import { describe, expect, it } from "vitest";
import { applyExactAssetLayers } from "../../../apps/web/src/lib/exact-assets";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

describe("identity-locked exact asset composition", () => {
  it("applies crop, rotation and partial-frame placement deterministically", async () => {
    const base = svgDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#ffffff"/></svg>',
    );
    const chickenLeg = svgDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#E5484D"/><circle cx="30" cy="50" r="18" fill="#111827"/></svg>',
    );

    const result = await applyExactAssetLayers(base, [
      {
        assetId: "chicken-leg-1",
        assetUrl: chickenLeg,
        assetMimeType: "image/svg+xml",
        transform: {
          xRatio: 1.05,
          yRatio: 0.55,
          widthRatio: 0.5,
          rotationDeg: 25,
          flipX: true,
          crop: { left: 0.1, top: 0, right: 0.15, bottom: 0 },
          zIndex: 2,
        },
      },
    ]);

    expect(result.appliedAssetIds).toEqual(["chicken-leg-1"]);
    expect(result.imageUrl).toMatch(/^data:image\/png;base64,/);
    const output = Buffer.from(
      result.imageUrl.split(",")[1] ?? "",
      "base64",
    );
    const sharpModule = await import("sharp");
    const { data, info } = await sharpModule
      .default(output)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let lockedSourcePixelCount = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      const blue = data[offset + 2] ?? 0;
      const alpha = data[offset + 3] ?? 0;
      if (red > 180 && green < 120 && blue < 120 && alpha > 0) {
        lockedSourcePixelCount += 1;
      }
    }
    expect(lockedSourcePixelCount).toBeGreaterThan(100);
  });

  it("fails closed when a locked asset is fully outside the output", async () => {
    const base = svgDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ffffff"/></svg>',
    );
    const asset = svgDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#111827"/></svg>',
    );

    await expect(
      applyExactAssetLayers(base, [
        {
          assetId: "outside",
          assetUrl: asset,
          transform: {
            xRatio: 1.5,
            yRatio: 1.5,
            widthRatio: 0.1,
            rotationDeg: 0,
            flipX: false,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
            zIndex: 0,
          },
        },
      ]),
    ).rejects.toThrow("fully outside");
  });
});
