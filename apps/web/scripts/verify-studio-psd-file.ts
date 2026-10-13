/** Actual PSD binary/reader proof using explicitly synthetic RGBA layers.
 * This verifies file-format/editability only: no provider, DB or AI quality
 * result is claimed. It can run in CI and in the installed production image. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { initializeCanvas, readPsd } from "ag-psd";
import { encodeStudioPsd, type StudioPsdLayer } from "../src/lib/studio-psd-codec";
export { readPsd as readPsdForFileProof } from "ag-psd";
// The decoder needs an ImageData allocator even with useImageData. Allocate
// real RGBA arrays without native node-canvas; no drawing/reader is mocked.
initializeCanvas(() => { throw new Error("This file proof never creates a canvas"); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }));

export async function verifyStudioPsdFile(outputDir?: string) {
  const width = 96, height = 64;
  const sources: Buffer[] = [];
  const rgba: Buffer[] = [];
  const names = ["Background - synthetic", "Red square - synthetic", "Blue translucent overlap - synthetic"];
  for (let order = 0; order < 3; order++) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (order === 0) pixels.set([240, 240, 248, 255], index);
      if (order === 1 && x >= 16 && x < 56 && y >= 12 && y < 52) pixels.set([220, 40, 70, 255], index);
      if (order === 2 && x >= 40 && x < 80 && y >= 20 && y < 48) pixels.set([40, 90, 240, 128], index);
    }
    rgba.push(pixels);
    sources.push(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  }
  const layers: StudioPsdLayer[] = sources.map((body, order) => ({ order, width, height, name: names[order]!, sizeBytes: body.length,
    assetSha256: createHash("sha256").update(body).digest("hex") }));
  const body = await encodeStudioPsd(width, height, layers, async layer => sources[layer.order]!, AbortSignal.timeout(10_000));
  const document = readPsd(body, { useImageData: true, skipThumbnail: true, totalMemoryLimit: 64 * 1024 * 1024 });
  const checks: string[] = [];
  function check(name: string, assertion: () => void) { assertion(); checks.push(name); }
  check("Actual PSD signature/version and native dimensions", () => {
    assert.equal(body.toString("ascii", 0, 4), "8BPS"); assert.equal(body.readUInt16BE(4), 1);
    assert.equal(body.readUInt32BE(14), height); assert.equal(body.readUInt32BE(18), width);
    assert.equal(document.width, width); assert.equal(document.height, height);
  });
  check("Three independently decoded pixel layers in Photoshop top-to-bottom order", () => {
    assert.equal(document.children?.length, 3);
    assert.deepEqual(document.children?.map(layer => layer.name), [...names].reverse());
    document.children?.forEach((layer, index) => {
      assert.ok(layer.imageData); assert.equal(layer.imageData.width, width); assert.equal(layer.imageData.height, height);
      assert.equal(layer.left, 0); assert.equal(layer.top, 0); assert.equal(layer.right, width); assert.equal(layer.bottom, height);
      assert.deepEqual(Buffer.from(layer.imageData.data), rgba[2 - index]);
    });
  });
  const pixel = (x: number, y: number) => Array.from(document.imageData!.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
  check("Transparent alpha and semitransparent pixels remain independently editable", () => {
    assert.equal(document.children![0]!.imageData!.data[3], 0);
    assert.equal(document.children![0]!.imageData!.data[(24 * width + 44) * 4 + 3], 128);
    assert.equal(document.children![1]!.imageData!.data[3], 0);
    assert.equal(document.children![2]!.imageData!.data[3], 255);
  });
  check("Stored composite preview matches known background/overlap order", () => {
    assert.ok(document.imageData);
    assert.deepEqual(pixel(0, 0), [240, 240, 248, 255]);
    assert.deepEqual(pixel(20, 20), [220, 40, 70, 255]);
    // Known blue 128/255 over opaque red, calculated independently.
    assert.deepEqual(pixel(44, 24), [130, 65, 155, 255]);
    assert.deepEqual(pixel(72, 24), [140, 165, 244, 255]);
  });
  const originalPreview = Buffer.from(document.imageData!.data);
  const reopened = document.children!.filter(layer => layer.name !== names[2]);
  const hiddenForegroundRender = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([...reopened].reverse().map(layer => ({ input: Buffer.from(layer.imageData!.data), raw: { width, height, channels: 4 as const } })))
    .raw().toBuffer();
  check("Hiding foreground in the reopened file changes the render while retaining layer bitmaps", () => {
    assert.equal(reopened.length, 2);
    const red = reopened.find(layer => layer.name === names[1])!;
    const offset = (24 * width + 44) * 4;
    assert.deepEqual(Array.from(red.imageData!.data.subarray(offset, offset + 4)), [220, 40, 70, 255]);
    assert.deepEqual(Array.from(hiddenForegroundRender.subarray(offset, offset + 4)), [220, 40, 70, 255]);
    assert.notDeepEqual(Array.from(originalPreview.subarray(offset, offset + 4)), [220, 40, 70, 255]);
  });
  const preview = await sharp(originalPreview, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const report = { kind: "synthetic-psd-file-format-proof", aiGenerated: false, realProviderAcceptance: false,
    width, height, layerCount: 3, sizeBytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), checks };
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "Novart-synthetic-editable-layers.psd"), body);
    await writeFile(path.join(outputDir, "Novart-synthetic-composite-preview.png"), preview);
    for (const layer of layers) await writeFile(path.join(outputDir, `synthetic-layer-${layer.order + 1}.png`), sources[layer.order]!);
    await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(path.join(outputDir, "README.md"), "# Novart 多图层 PSD 文件格式样例\n\n这是明确的合成 RGBA 图层测试，未调用 AI，不代表真实模型分层质量。\n\nPSD 有背景、红色方块、蓝色半透明前景三个独立像素图层。用 Photoshop 打开后可分别隐藏、移动和编辑；96 × 64 原始画幅及透明通道保留。PNG 是文件内合成预览。report.json 记录真实二进制回读检查和 SHA-256。\n");
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyStudioPsdFile(process.env.NOVART_PSD_PROOF_DIR).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
