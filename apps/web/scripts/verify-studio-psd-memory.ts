/** Native-size sparse-layer PSD proof. These known RGBA shapes are explicitly
 * synthetic, not AI results, model-quality evidence or business records. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { readPsdForFileProof } from "./verify-studio-psd-file";
import { encodeStudioPsd, estimateStudioPsdMemory, STUDIO_PSD_MAX_MEMORY_BYTES, type StudioPsdLayer } from "../src/lib/studio-psd-codec";

export async function verifyStudioPsdMemory(outputDir?: string) {
  const width = 2048, height = 2048, sources: Buffer[] = [];
  const boxes = [{ left: 0, top: 0, width, height }, ...Array.from({ length: 7 }, (_, index) =>
    ({ left: 20 + (index + 1) * 210, top: 40 + (index + 1) * 150, width: 100, height: 80 }))];
  for (const [order, box] of boxes.entries()) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
      const alpha = order === 0 || (x > 0 && y > 0) ? 255 : 1;
      pixels.set([order * 20, 90, 120, alpha], ((box.top + y) * width + box.left + x) * 4);
    }
    sources.push(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  }
  const layers: StudioPsdLayer[] = sources.map((body, order) => ({ order, width, height, name: `Synthetic layer ${order}`,
    sizeBytes: body.length, assetSha256: createHash("sha256").update(body).digest("hex") }));
  const budget = estimateStudioPsdMemory(width, height, boxes);
  assert.ok(budget.peakBytes < STUDIO_PSD_MAX_MEMORY_BYTES);
  const body = await encodeStudioPsd(width, height, layers, async layer => sources[layer.order]!, AbortSignal.timeout(30_000));
  const document = readPsdForFileProof(body, { useImageData: true, skipThumbnail: true, totalMemoryLimit: 128 * 1024 * 1024 });
  assert.equal(document.width, width); assert.equal(document.height, height); assert.equal(document.children?.length, 8);
  let checkedPixels = 0;
  for (const [index, layer] of document.children!.entries()) {
    const order = 7 - index, box = boxes[order]!;
    assert.equal(layer.left, box.left); assert.equal(layer.top, box.top);
    assert.equal(layer.imageData?.width, box.width); assert.equal(layer.imageData?.height, box.height);
    for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
      const offset = (y * box.width + x) * 4, data = layer.imageData!.data;
      const alpha = order === 0 || (x > 0 && y > 0) ? 255 : 1;
      // Bounded diagnostics, even if an actual 2K file is malformed.
      if (data[offset] !== order * 20 || data[offset + 1] !== 90 || data[offset + 2] !== 120 || data[offset + 3] !== alpha) {
        throw new Error(`Reopened source pixel mismatch at layer=${order}, x=${x}, y=${y}`);
      }
      checkedPixels++;
    }
  }
  const dense = estimateStudioPsdMemory(width, height, [boxes[0]!, boxes[0]!, boxes[0]!]);
  assert.ok(dense.peakBytes > STUDIO_PSD_MAX_MEMORY_BYTES);
  const report = { kind: "synthetic-native-2k-psd-memory-proof", aiGenerated: false, realProviderAcceptance: false,
    width, height, layerCount: 8, sizeBytes: body.length, sha256: createHash("sha256").update(body).digest("hex"),
    checkedPixels, fullFrameRgbaBytesBefore: width * height * 4 * layers.length,
    croppedRgbaBytes: budget.croppedRgbaBytes, conservativePeakBytes: budget.peakBytes,
    resourceLimitBytes: STUDIO_PSD_MAX_MEMORY_BYTES, writerCapacityBytes: budget.writerCapacityBytes,
    threeDenseLayersExceedBudget: true,
    checks: ["Actual PSD readback: 2048x2048 canvas, eight independent layers", "Every reopened layer RGBA pixel and stored position match known sources",
      "Alpha=1 shadows outside thresholded ink bounds survive", "Cropped buffers and fixed writer fit unchanged resource budget; dense group fails guard"] };
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "DeepFlare-synthetic-2k-eight-layers.psd"), body);
    await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyStudioPsdMemory(process.env.NOVART_PSD_MEMORY_PROOF_DIR).then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
