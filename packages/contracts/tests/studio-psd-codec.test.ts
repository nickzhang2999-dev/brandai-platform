import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { assertStudioPsdBudget, encodeStudioPsd, STUDIO_PSD_MAX_MEMORY_BYTES, type StudioPsdLayer } from "../../../apps/web/src/lib/studio-psd-codec";
import { readPsdForFileProof as readPsd, verifyStudioPsdFile } from "../../../apps/web/scripts/verify-studio-psd-file";

async function fixture(allOpaque = false) {
  const width = 8, height = 8;
  const bytes = await Promise.all([0, 1].map(async order => {
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const alpha = order === 0 || allOpaque || (i > 10 && i < 30) ? 255 : 0;
      pixels.set([order ? 220 : 50, 70, 130, alpha], i * 4);
    }
    return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }));
  const layers: StudioPsdLayer[] = bytes.map((body, order) => ({ order, width, height, sizeBytes: body.length,
    assetSha256: createHash("sha256").update(body).digest("hex") }));
  return { width, height, bytes, layers };
}
describe("Studio PSD codec: actual binary encode/readback, synthetic pixels only", () => {
  it("proves independent layers, straight alpha, order and expected composite pixels with actual writer/reader", async () => {
    const report = await verifyStudioPsdFile();
    expect(report).toMatchObject({ aiGenerated: false, realProviderAcceptance: false, layerCount: 3, width: 96, height: 64 });
    expect(report.checks).toHaveLength(5); expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("bounds decoded pixels and writer copies before loading any files", async () => {
    expect(STUDIO_PSD_MAX_MEMORY_BYTES).toBe(256 * 1024 * 1024);
    expect(() => assertStudioPsdBudget(1024, 1024, 10)).not.toThrow();
    for (const dimensions of [[4096, 4096, 10], [2048, 2048, 4], [0, 2, 2], [2, 2, 1], [1, 1, 11], [2.5, 2, 2]]) {
      expect(() => assertStudioPsdBudget(dimensions[0]!, dimensions[1]!, dimensions[2]!)).toThrow(/内存上限/);
    }
    const f = await fixture(), read = vi.fn();
    await expect(encodeStudioPsd(4096, 4096, f.layers, read, AbortSignal.timeout(3000))).rejects.toMatchObject({ status: 422 });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects partial, duplicate, wrong-size, opaque-only and empty layer groups instead of single-layer PSDs", async () => {
    const f = await fixture();
    for (const layers of [[f.layers[0]!], [f.layers[0]!, { ...f.layers[1]!, order: 0 }], [f.layers[0]!, { ...f.layers[1]!, width: 7 }]]) {
      await expect(encodeStudioPsd(f.width, f.height, layers, async layer => f.bytes[layer.order]!, AbortSignal.timeout(3000))).rejects.toMatchObject({ status: 422 });
    }
    const opaque = await fixture(true);
    await expect(encodeStudioPsd(8, 8, opaque.layers, async layer => opaque.bytes[layer.order]!, AbortSignal.timeout(3000))).rejects.toMatchObject({ status: 422 });
    const empty = await sharp(Buffer.alloc(8 * 8 * 4), { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
    const layers = [f.layers[0]!, { ...f.layers[1]!, sizeBytes: empty.length, assetSha256: createHash("sha256").update(empty).digest("hex") }];
    await expect(encodeStudioPsd(8, 8, layers, async layer => layer.order === 1 ? empty : f.bytes[0]!, AbortSignal.timeout(3000))).rejects.toMatchObject({ status: 422 });
  });
  it("checks actual image bytes, digest, size and dimensions before encoding", async () => {
    const f = await fixture();
    await expect(encodeStudioPsd(8, 8, f.layers, async () => f.bytes[0]!, AbortSignal.timeout(3000))).rejects.toMatchObject({ status: 422 });
    const bad = Buffer.from("not a PNG");
    const layers = f.layers.map(layer => ({ ...layer, sizeBytes: bad.length, assetSha256: createHash("sha256").update(bad).digest("hex") }));
    await expect(encodeStudioPsd(8, 8, layers, async () => bad, AbortSignal.timeout(3000))).rejects.toMatchObject({ status: 422 });
  });
  it("preserves explicit abort and bounds a reader that ignores cancellation", async () => {
    const f = await fixture(), aborted = new AbortController(), reader = vi.fn(); aborted.abort(new Error("fixture cancel"));
    await expect(encodeStudioPsd(8, 8, f.layers, reader, aborted.signal)).rejects.toThrow("fixture cancel");
    expect(reader).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = encodeStudioPsd(8, 8, f.layers, async () => new Promise<Buffer>(() => undefined), controller.signal);
    controller.abort(new Error("fixture I/O deadline"));
    await expect(pending).rejects.toThrow("fixture I/O deadline");
  });
  it("supports a fully opaque composite without turning the bottom image into a locked Photoshop background", async () => {
    const f = await fixture();
    const body = await encodeStudioPsd(8, 8, f.layers, async layer => f.bytes[layer.order]!, AbortSignal.timeout(3000));
    const psd = readPsd(body, { useImageData: true });
    expect(psd.children).toHaveLength(2); expect(psd.children?.every(layer => layer.imageData?.data.length === 8 * 8 * 4)).toBe(true);
    expect(psd.imageData!.data[3]).toBe(255); expect(psd.children![0]!.imageData!.data[3]).toBe(0);
  });
});
