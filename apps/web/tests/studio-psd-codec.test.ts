import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { assertStudioPsdBudget, encodeStudioPsd, estimateStudioPsdMemory, STUDIO_PSD_MAX_MEMORY_BYTES, type StudioPsdLayer } from "../src/lib/studio-psd-codec";
import { readPsdForFileProof as readPsd, verifyStudioPsdFile } from "../scripts/verify-studio-psd-file";

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
  it.each([1, 4, 63])("writes and reopens a complete faint layer at alpha=%i unchanged", async alpha => {
    const f = await fixture();
    const raw = Buffer.alloc(8 * 8 * 4);
    raw.set([120, 70, 220, alpha], (2 * 8 + 3) * 4);
    const faint = await sharp(raw, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
    f.bytes[1] = faint;
    f.layers[1] = { ...f.layers[1]!, sizeBytes: faint.length, assetSha256: createHash("sha256").update(faint).digest("hex") };
    const body = await encodeStudioPsd(8, 8, f.layers, async layer => f.bytes[layer.order]!, AbortSignal.timeout(3000));
    const document = readPsd(body, { useImageData: true });
    expect(document.children).toHaveLength(2);
    const layer = document.children![0]!;
    expect([layer.left, layer.top, layer.imageData!.width, layer.imageData!.height]).toEqual([3, 2, 1, 1]);
    expect([...layer.imageData!.data]).toEqual([120, 70, 220, alpha]);
  });
  it("proves independent layers, straight alpha, order and expected composite pixels with actual writer/reader", async () => {
    const report = await verifyStudioPsdFile();
    expect(report).toMatchObject({ aiGenerated: false, realProviderAcceptance: false, layerCount: 3, width: 96, height: 64 });
    expect(report.checks).toHaveLength(5); expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("bounds decoded pixels and writer copies before loading any files", async () => {
    expect(STUDIO_PSD_MAX_MEMORY_BYTES).toBe(256 * 1024 * 1024);
    expect(() => assertStudioPsdBudget(1024, 1024, 10)).not.toThrow();
    expect(() => assertStudioPsdBudget(2048, 2048, 10)).not.toThrow();
    for (const dimensions of [[4096, 4096, 10], [0, 2, 2], [2, 2, 1], [1, 1, 11], [2.5, 2, 2]]) {
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
  it("keeps incompressible RGBA within the fixed writer capacity without truncating channels", async () => {
    const width = 129, height = 41, sources: Buffer[] = [], pixels: Buffer[] = [];
    let state = 38171;
    for (let order = 0; order < 3; order++) {
      const raw = Buffer.alloc(width * height * 4);
      for (let index = 0; index < raw.length; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        raw[index] = (state >>> 24) || 1;
      }
      pixels.push(raw); sources.push(await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer());
    }
    const layers = sources.map((body, order) => ({ order, width, height, sizeBytes: body.length, assetSha256: createHash("sha256").update(body).digest("hex") }));
    const body = await encodeStudioPsd(width, height, layers, async layer => sources[layer.order]!, AbortSignal.timeout(3000));
    expect(body.length).toBeLessThan(estimateStudioPsdMemory(width, height, layers).writerCapacityBytes);
    const document = readPsd(body, { useImageData: true });
    expect(document.children).toHaveLength(3);
    for (let index = 0; index < 3; index++) {
      expect({ exact: Buffer.from(document.children![index]!.imageData!.data).equals(pixels[2 - index]!) }).toEqual({ exact: true });
    }
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
    expect(psd.children).toHaveLength(2);
    expect(psd.children![1]!.imageData!.data.length).toBe(8 * 8 * 4);
    expect(psd.children![0]!.top).toBe(1); expect(psd.children![0]!.bottom).toBe(4);
    expect(psd.children![0]!.imageData!.height).toBe(3);
    expect(psd.imageData!.data[3]).toBe(255);
  });
  it("exports eight 2K sparse layers at native size and retains alpha=1 shadows outside ink bounds", async () => {
    const width = 2048, height = 2048, sources: Buffer[] = [], boxes: Array<{ left: number; top: number; width: number; height: number }> = [];
    for (let order = 0; order < 8; order++) {
      const box = order === 0 ? { left: 0, top: 0, width, height } : { left: 20 + order * 210, top: 40 + order * 150, width: 100, height: 80 };
      boxes.push(box);
      const pixels = Buffer.alloc(width * height * 4);
      for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
        pixels.set([order * 20, 90, 120, order === 0 || (x !== box.left && y !== box.top) ? 255 : 1], (y * width + x) * 4);
      }
      sources.push(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
    }
    const layers: StudioPsdLayer[] = sources.map((body, order) => ({ order, width, height, name: `Synthetic ${order}`,
      sizeBytes: body.length, assetSha256: createHash("sha256").update(body).digest("hex") }));
    const budget = estimateStudioPsdMemory(width, height, boxes);
    expect(budget.croppedRgbaBytes).toBeLessThan(width * height * 4 * 2);
    expect(budget.peakBytes).toBeLessThan(STUDIO_PSD_MAX_MEMORY_BYTES);
    const body = await encodeStudioPsd(width, height, layers, async layer => sources[layer.order]!, AbortSignal.timeout(30_000));
    const document = readPsd(body, { useImageData: true, totalMemoryLimit: 128 * 1024 * 1024 });
    expect(document.width).toBe(width); expect(document.height).toBe(height); expect(document.children).toHaveLength(8);
    for (const [index, layer] of document.children!.entries()) {
      const sourceIndex = 7 - index, box = boxes[sourceIndex]!;
      expect(layer.name).toBe(`Synthetic ${sourceIndex}`); expect(layer.left).toBe(box.left); expect(layer.top).toBe(box.top);
      expect(layer.imageData!.width).toBe(box.width); expect(layer.imageData!.height).toBe(box.height);
      expect(layer.imageData!.data[3]).toBe(sourceIndex ? 1 : 255);
      expect(Array.from(layer.imageData!.data.subarray((box.width + 1) * 4, (box.width + 1) * 4 + 4))).toEqual([sourceIndex * 20, 90, 120, 255]);
    }
    // Recompose actual reopened crops with stored positions, not fixture layers.
    const composed = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([...document.children!].reverse().map(layer => ({ input: Buffer.from(layer.imageData!.data), left: layer.left!, top: layer.top!,
        raw: { width: layer.imageData!.width, height: layer.imageData!.height, channels: 4 as const } }))).raw().toBuffer();
    const preview = Buffer.from(document.imageData!.data);
    // Never feed multi-megabyte arrays to Vitest's deep-diff renderer: one
    // differing subpixel can otherwise allocate gigabytes of diagnostic text.
    const exact = Buffer.alloc(width * height * 4);
    for (let index = 0; index < exact.length; index += 4) exact.set([0, 90, 120, 255], index);
    for (let order = 1; order < boxes.length; order++) {
      const box = boxes[order]!;
      for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
        const alpha = x && y ? 255 : 1;
        exact[((box.top + y) * width + box.left + x) * 4] = Math.round(order * 20 * alpha / 255);
      }
    }
    expect({ matchesExactKnownComposite: preview.equals(exact), sizeBytes: preview.length }).toEqual({ matchesExactKnownComposite: true, sizeBytes: width * height * 4 });
    let maximumRgbDifference = 0, alphaDifferences = 0;
    for (let index = 0; index < composed.length; index++) {
      if (index % 4 === 3) { if (composed[index] !== preview[index]) alphaDifferences++; }
      else maximumRgbDifference = Math.max(maximumRgbDifference, Math.abs(composed[index]! - preview[index]!));
    }
    // libvips truncates some alpha=1 RGB blends; the PSD composite uses nearest
    // integer as proved exactly above. Alpha/position/cropped source are exact.
    expect({ alphaDifferences, maximumRgbDifference }).toEqual({ alphaDifferences: 0, maximumRgbDifference: 1 });
  }, 30_000);
  it("rejects a dense 2K group from actual crop memory before decoding later files or starting the writer", async () => {
    const width = 2048, height = 2048;
    const dense = { width, height };
    expect(estimateStudioPsdMemory(width, height, [dense, dense, dense]).peakBytes).toBeGreaterThan(STUDIO_PSD_MAX_MEMORY_BYTES);
    const pixels = Buffer.alloc(width * height * 4, 100);
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 128;
    const body = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const layers = [0, 1, 2, 3].map(order => ({ order, width, height, sizeBytes: body.length,
      assetSha256: createHash("sha256").update(body).digest("hex") }));
    const reader = vi.fn(async () => body);
    await expect(encodeStudioPsd(width, height, layers, reader, AbortSignal.timeout(30_000))).rejects.toMatchObject({ status: 422 });
    expect(reader).toHaveBeenCalledTimes(3);
  }, 30_000);
});
