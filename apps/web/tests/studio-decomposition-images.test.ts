import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/s3", () => ({ getObjectStream: vi.fn() }));
vi.mock("../src/lib/ssrf", () => ({ safeFetch: vi.fn() }));
vi.mock("../src/lib/watermark", () => ({ applyWatermarksToImage: vi.fn() }));
import { assertStudioLayerBudget, inspectStudioLayer, STUDIO_LAYER_TOTAL_PIXELS } from "../src/lib/studio-decomposition-images";

const signal = () => AbortSignal.timeout(3000);
async function fixture(width: number, height: number, ink?: { left: number; top: number; width: number; height: number; alpha?: number }) {
  const rgba = Buffer.alloc(width * height * 4);
  if (ink) for (let y = ink.top; y < ink.top + ink.height; y++) for (let x = ink.left; x < ink.left + ink.width; x++) {
    const offset = (y * width + x) * 4;
    rgba[offset] = 120; rgba[offset + 1] = 70; rgba[offset + 2] = 220; rgba[offset + 3] = ink.alpha ?? 255;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

describe("Studio decomposition image boundary (local fixtures; no provider or DB calls)", () => {
  it("bounds the whole layer group before allocating decoded pixels", () => {
    expect(STUDIO_LAYER_TOTAL_PIXELS).toBe(40_000_000);
    expect(() => assertStudioLayerBudget(2000, 2000, 10)).not.toThrow();
    expect(() => assertStudioLayerBudget(16384, 1, 2)).not.toThrow();
    for (const [width, height, count] of [[2001, 2000, 10], [16385, 1, 2], [0, 1, 2], [1, -1, 2], [1.5, 2, 2], [1, 1, 1], [1, 1, 11], [1, 1, 2.5], [NaN, 1, 2], [1, Infinity, 2]]) {
      expect(() => assertStudioLayerBudget(width!, height!, count!)).toThrow(/减少图层数或降低原图尺寸/);
    }
  });
  it("retains the full transparent canvas and calculates ink bounds from actual alpha", async () => {
    const result = await inspectStudioLayer(await fixture(12, 8, { left: 3, top: 2, width: 4, height: 3 }), 12, 8, signal());
    expect(result).toMatchObject({ mimeType: "image/png", width: 12, height: 8,
      alphaBounds: { left: 3, top: 2, width: 4, height: 3 }, inkCoverage: 12 / 96, hasTransparency: true });
    expect(result.assetSha256).toBe(createHash("sha256").update(result.body).digest("hex"));
    expect(result.sizeBytes).toBe(result.body.length);
    const decoded = await sharp(result.body).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 12, height: 8, channels: 4 });
    expect([...decoded.data.subarray((2 * 12 + 3) * 4, (2 * 12 + 3) * 4 + 4)]).toEqual([120, 70, 220, 255]);
    expect(decoded.data[3]).toBe(0);
  });
  it("allows an opaque background while reporting that it has no transparency", async () => {
    const bytes = await fixture(12, 8, { left: 0, top: 0, width: 12, height: 8 });
    const result = await inspectStudioLayer(bytes, 12, 8, signal());
    expect(result).toMatchObject({ alphaBounds: { left: 0, top: 0, width: 12, height: 8 }, inkCoverage: 1, hasTransparency: false });
    const jpeg = await sharp(bytes).jpeg().toBuffer();
    expect(await inspectStudioLayer(jpeg, 12, 8, signal())).toMatchObject({ mimeType: "image/png", hasTransparency: false });
  });
  it("normalizes a smaller same-aspect full frame to source dimensions without flattening", async () => {
    const result = await inspectStudioLayer(await fixture(12, 8, { left: 3, top: 2, width: 4, height: 3 }), 24, 16, signal());
    expect(result).toMatchObject({ width: 24, height: 16, hasTransparency: true });
    expect(result.alphaBounds.left).toBeGreaterThan(0);
    expect(result.alphaBounds.top).toBeGreaterThan(0);
    expect(result.alphaBounds.left + result.alphaBounds.width).toBeLessThan(24);
    expect(result.alphaBounds.top + result.alphaBounds.height).toBeLessThan(16);
    const rgba = await sharp(result.body).raw().toBuffer();
    expect(rgba[3]).toBe(0);
  });
  it.each([[160, 90], [120, 90], [90, 160]])("keeps full-frame non-square layers aligned at %i×%i (synthetic, not provider acceptance)", async (width, height) => {
    const result = await inspectStudioLayer(await fixture(width, height, { left: 10, top: 12, width: 20, height: 18 }), width, height, signal());
    expect(result).toMatchObject({ width, height, alphaBounds: { left: 10, top: 12, width: 20, height: 18 }, hasTransparency: true });
    const normalized = await inspectStudioLayer(await fixture(width, height, { left: 10, top: 12, width: 20, height: 18 }), width * 2, height * 2, signal());
    expect(normalized).toMatchObject({ width: width * 2, height: height * 2, hasTransparency: true });
  });
  it("reports measured source and returned dimensions and separates aspect mismatch from oversize", async () => {
    const bytes = await fixture(160, 90, { left: 10, top: 12, width: 20, height: 18 });
    await expect(inspectStudioLayer(bytes, 160, 91, signal())).rejects.toThrow("原图 160×91，返回图层 160×90");
    await expect(inspectStudioLayer(bytes, 80, 45, signal())).rejects.toThrow("尺寸超出原图");
    await expect(inspectStudioLayer(bytes, 160, 91, signal())).rejects.toThrow("比例与原图不一致");
  });
  it.each([[159, 90], [160, 89], [160, 91]])("does not assume a one-pixel crop or pad (%i×%i) is a verified full frame", async (width, height) => {
    await expect(inspectStudioLayer(await fixture(width, height, { left: 10, top: 12, width: 20, height: 18 }), 160, 90, signal())).rejects.toMatchObject({ status: 422 });
  });
  it("rejects cropped proportions and oversized provider frames rather than distorting their positions", async () => {
    const bytes = await fixture(12, 8, { left: 3, top: 2, width: 4, height: 3 });
    for (const [width, height] of [[12, 12], [24, 15], [6, 4]]) {
      await expect(inspectStudioLayer(bytes, width!, height!, signal())).rejects.toMatchObject({ status: 422 });
    }
  });
  it("rejects fully transparent layers but keeps the coverage threshold", async () => {
    await expect(inspectStudioLayer(await fixture(12, 8), 12, 8, signal())).rejects.toMatchObject({ status: 422 });
    const result = await inspectStudioLayer(await fixture(12, 8, { left: 1, top: 1, width: 2, height: 2, alpha: 64 }), 12, 8, signal());
    expect(result).toMatchObject({ alphaBounds: { left: 1, top: 1, width: 2, height: 2 }, inkCoverage: 4 / 96, hasTransparency: true });
  });
  it.each([1, 4, 63])("preserves a whole faint layer at alpha=%i without amplifying it", async alpha => {
    const result = await inspectStudioLayer(await fixture(12, 8, { left: 1, top: 1, width: 2, height: 2, alpha }), 12, 8, signal());
    expect(result).toMatchObject({ alphaBounds: { left: 1, top: 1, width: 2, height: 2 }, inkCoverage: 0, hasTransparency: true });
    const raw = await sharp(result.body).raw().toBuffer();
    expect([...raw.subarray((12 + 1) * 4, (12 + 1) * 4 + 4)]).toEqual([120, 70, 220, alpha]);
    expect(raw[3]).toBe(0);
  });
  it("rejects corrupt, non-raster, oversized, animated and invalid source inputs", async () => {
    const bytes = await fixture(12, 8, { left: 1, top: 1, width: 2, height: 2 });
    for (const bad of [Buffer.alloc(0), bytes.subarray(0, 40), Buffer.from("not an image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>'), Buffer.alloc(32 * 1024 * 1024 + 1)]) {
      await expect(inspectStudioLayer(bad, 12, 8, signal())).rejects.toMatchObject({ status: 422 });
    }
    // A 1x1 GIF with red and green frames; Sharp creates the animated WebP.
    const gif = Buffer.from("47494638396101000100800000ff000000ff0021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b", "hex");
    const animatedWebp = await sharp(gif, { animated: true }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(animatedWebp, { animated: true }).metadata()).pages).toBe(2);
    await expect(inspectStudioLayer(animatedWebp, 1, 1, signal())).rejects.toMatchObject({ status: 422 });
    for (const [width, height] of [[16385, 1], [10000, 5000], [0, 8], [12, 8.5]]) {
      await expect(inspectStudioLayer(bytes, width!, height!, signal())).rejects.toMatchObject({ status: 422 });
    }
  });
  it("preserves an explicit abort reason without decoding or publishing late bytes", async () => {
    const controller = new AbortController(); controller.abort(new Error("fixture deadline"));
    await expect(inspectStudioLayer(await fixture(12, 8), 12, 8, controller.signal)).rejects.toThrow("fixture deadline");
  });
});
