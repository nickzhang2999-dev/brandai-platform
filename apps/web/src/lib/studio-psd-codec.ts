import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp from "sharp";

/** PSD file-format checks are independent of the model and persistence layer. */
export class StudioPsdEncodingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const STUDIO_PSD_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
export const STUDIO_PSD_MAX_FILE_BYTES = 96 * 1024 * 1024;
export const STUDIO_PSD_DEADLINE_MS = 30_000;
export type StudioPsdLayer = {
  order: number; width: number; height: number; assetSha256: string; sizeBytes: number; name?: string;
};
type LayerSize = { width: number; height: number };
type DecodedLayer = LayerSize & { left: number; top: number; name: string; pixels: ArrayBuffer };
const PSD_WORKING_RESERVE_BYTES = 32 * 1024 * 1024;
const PSD_MAX_LAYER_FILE_BYTES = 32 * 1024 * 1024;

// PackBits uses up to one literal header per 128 pixels, plus a possible
// two-byte tail and the two-byte scanline length for each of four channels.
// This is a bound on incompressible data, never an estimate from PNG size.
function rleByteBound(width: number, height: number) {
  return 4 * height * (width + Math.ceil(width / 128) + 4);
}

/** Live allocations for the installed ag-psd writer: cropped RGBA, encoded
 * layer channels, fixed-capacity output, composite + its copy and the native
 * RLE scratch buffer. Preparation separately includes one full-frame decode,
 * its cropping copy, the bounded PNG and native-library working space.
 * Export verifies every visible alpha pixel before using these dimensions. */
export function estimateStudioPsdMemory(width: number, height: number, sizes: readonly LayerSize[]) {
  const nativeRgbaBytes = width * height * 4;
  const croppedRgbaBytes = sizes.reduce((total, layer) => total + layer.width * layer.height * 4, 0);
  const layerChannelBytes = sizes.reduce((total, layer) => total + rleByteBound(layer.width, layer.height), 0);
  const writerCapacityBytes = 65_536 + sizes.length * 4_096 + layerChannelBytes + rleByteBound(width, height);
  const encodingPeakBytes = croppedRgbaBytes + layerChannelBytes + writerCapacityBytes + nativeRgbaBytes * 4 + PSD_WORKING_RESERVE_BYTES;
  const preparationPeakBytes = croppedRgbaBytes + nativeRgbaBytes * 2 + PSD_MAX_LAYER_FILE_BYTES + PSD_WORKING_RESERVE_BYTES;
  return { croppedRgbaBytes, writerCapacityBytes, peakBytes: Math.max(encodingPeakBytes, preparationPeakBytes) };
}

function assertPixelBudget(width: number, height: number, sizes: readonly LayerSize[]) {
  const budget = estimateStudioPsdMemory(width, height, sizes);
  if (budget.peakBytes > STUDIO_PSD_MAX_MEMORY_BYTES || budget.writerCapacityBytes > STUDIO_PSD_MAX_FILE_BYTES) {
    throw new StudioPsdEncodingError(422, "图层的实际像素超过 PSD 导出资源上限；原图与完整图层仍保留，未丢层或降低分辨率。");
  }
  return budget;
}

// Before calling a model, only the native canvas/decode baseline is knowable.
// Full-frame transparent PNGs do not mean every layer occupies that frame in
// a PSD. The actual crop budget is enforced after reading and checking pixels.
export function assertStudioPsdBudget(width: number, height: number, count: number) {
  if (![width, height, count].every(Number.isSafeInteger) || width < 1 || height < 1 || width > 16384 || height > 16384 || count < 2 || count > 10
    || estimateStudioPsdMemory(width, height, []).peakBytes > STUDIO_PSD_MAX_MEMORY_BYTES) {
    throw new StudioPsdEncodingError(422, "原图画幅超过 PSD 导出内存上限；原图与完整图层仍保留，未丢层或降低分辨率。");
  }
}

/** A constant, trusted program: neither layer names nor metadata are executed.
 * Actual synchronous PSD encoding runs outside Next's request event loop, so
 * a request deadline/client disconnect can terminate even the RLE writer. */
const writerProgram = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { createWriter, writePsd, getWriterBufferNoCopy } = require(workerData.writerModulePath);
try {
  const { width, height, layers, maxBytes, writerCapacityBytes, hasTransparency } = workerData;
  const composite = new Uint8ClampedArray(width * height * 4);
  const children = [];
  for (const layer of layers) {
    const rgba = new Uint8ClampedArray(layer.pixels);
    let hasPixels = false;
    for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
      const i = (y * layer.width + x) * 4;
      const target = ((y + layer.top) * width + x + layer.left) * 4;
      const alpha = rgba[i + 3];
      if (alpha > 0) hasPixels = true;
      if (!alpha) continue;
      const a = alpha / 255;
      const previous = composite[target + 3] / 255;
      const outputAlpha = a + previous * (1 - a);
      for (let channel = 0; channel < 3; channel++) {
        composite[target + channel] = Math.round((rgba[i + channel] * a + composite[target + channel] * previous * (1 - a)) / outputAlpha);
      }
      composite[target + 3] = Math.round(outputAlpha * 255);
    }
    if (!hasPixels) throw new Error('empty-layer');
    children.push({ name: layer.name, left: layer.left, top: layer.top, blendMode: 'normal', opacity: 1, hidden: false,
      imageData: { width: layer.width, height: layer.height, data: rgba } });
  }
  if (!hasTransparency) throw new Error('no-transparency');
  // Studio order=0 is the background; ag-psd children are top-to-bottom.
  // The pinned writer's exported primitives let us preallocate its proven
  // RLE upper bound, avoiding doubling/reallocation and final buffer slicing.
  const writer = createWriter(writerCapacityBytes);
  const outputBuffer = writer.buffer;
  writePsd(writer, { width, height, children: children.reverse(), imageData: { width, height, data: composite } },
    { noBackground: true, trimImageData: false, generateThumbnail: false });
  if (writer.buffer !== outputBuffer) throw new Error('writer-bound');
  const body = getWriterBufferNoCopy(writer);
  if (body.byteLength > maxBytes) throw new Error('file-budget');
  parentPort.postMessage({ body: body.buffer, sizeBytes: body.byteLength }, [body.buffer]);
} catch { parentPort.postMessage({ error: true }); }
`;

function deadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  void work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function encodeStudioPsd(
  width: number, height: number, layers: StudioPsdLayer[],
  readLayer: (layer: StudioPsdLayer, signal: AbortSignal) => Promise<Buffer>,
  signal: AbortSignal,
): Promise<Buffer> {
  assertStudioPsdBudget(width, height, layers.length);
  signal.throwIfAborted();
  const sorted = [...layers].sort((a, b) => a.order - b.order);
  if (sorted.some((layer, index) => layer.order !== index || layer.width !== width || layer.height !== height
    || !/^[a-f0-9]{64}$/.test(layer.assetSha256) || !Number.isSafeInteger(layer.sizeBytes) || layer.sizeBytes < 1 || layer.sizeBytes > 32 * 1024 * 1024)) {
    throw new StudioPsdEncodingError(422, "图层回执不完整，未导出部分或错位的 PSD。");
  }
  const decoded: DecodedLayer[] = [];
  let hasTransparency = false;
  for (const layer of sorted) {
    signal.throwIfAborted();
    const bytes = await deadline(readLayer(layer, signal), signal);
    if (bytes.length !== layer.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== layer.assetSha256) {
      throw new StudioPsdEncodingError(422, "图层图片完整性校验失败，未导出 PSD。");
    }
    const image = sharp(bytes, { limitInputPixels: width * height, failOn: "warning" });
    const abort = () => { image.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const meta = await deadline(image.metadata(), signal);
      if (meta.format !== "png" || meta.width !== width || meta.height !== height || (meta.pages ?? 1) !== 1 || (meta.orientation ?? 1) !== 1) {
        throw new StudioPsdEncodingError(422, "图层尺寸或格式与原图不一致，未拉伸、裁切或导出。");
      }
      const raw = await deadline(image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }), signal);
      if (raw.info.channels !== 4 || raw.data.length !== width * height * 4) throw new StudioPsdEncodingError(422, "图层像素读取失败。");
      let left = width, top = height, right = -1, bottom = -1;
      for (let y = 0; y < height; y++) {
        signal.throwIfAborted();
        for (let x = 0; x < width; x++) {
          const alpha = raw.data[(y * width + x) * 4 + 3]!;
          if (alpha < 255) hasTransparency = true;
          // Every nonzero alpha belongs in the crop, even when the entire
          // layer is a faint shadow. Never amplify or discard its opacity.
          if (!alpha) continue;
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      if (right < left) throw new StudioPsdEncodingError(422, "图层没有有效透明内容，未导出不完整的 PSD。");
      const crop = { width: right - left + 1, height: bottom - top + 1 };
      // Reject before allocating another crop or starting the writer; layer
      // count alone never stands in for the actual visible pixel budget.
      assertPixelBudget(width, height, [...decoded, crop]);
      const pixels = new ArrayBuffer(crop.width * crop.height * 4), target = new Uint8Array(pixels);
      for (let y = 0; y < crop.height; y++) {
        signal.throwIfAborted();
        const offset = ((top + y) * width + left) * 4;
        target.set(raw.data.subarray(offset, offset + crop.width * 4), y * crop.width * 4);
      }
      // A dedicated transferable prevents a pooled Buffer from cloning a much
      // larger underlying slab; main-thread crop buffers detach on transfer.
      decoded.push({ ...crop, left, top, name: (layer.name ?? `图层 ${layer.order + 1}`).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80), pixels });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof StudioPsdEncodingError) throw error;
      throw new StudioPsdEncodingError(422, "图层图片损坏，未导出 PSD。");
    } finally { signal.removeEventListener("abort", abort); image.destroy(); }
  }
  signal.throwIfAborted();
  const budget = assertPixelBudget(width, height, decoded);
  const writerModulePath = createRequire(import.meta.url).resolve("ag-psd/dist/psdWriter.js");
  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(writerProgram, {
      eval: true, workerData: { width, height, layers: decoded, hasTransparency, maxBytes: STUDIO_PSD_MAX_FILE_BYTES,
        writerModulePath, writerCapacityBytes: budget.writerCapacityBytes },
      transferList: decoded.map(layer => layer.pixels), resourceLimits: { maxOldGenerationSizeMb: 160, maxYoungGenerationSizeMb: 16 },
    });
    let finished = false;
    const cleanup = () => { signal.removeEventListener("abort", abort); return worker.terminate().catch(() => undefined); };
    const settle = (error?: unknown, body?: ArrayBuffer, sizeBytes?: number) => {
      if (finished) return; finished = true;
      // Keep the service's single-export slot until the thread has actually
      // stopped and released its decoded buffers, including on cancellation.
      void cleanup().then(() => { if (error) reject(error); else resolve(Buffer.from(body!, 0, sizeBytes!)); });
    };
    const abort = () => settle(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: { body?: ArrayBuffer; sizeBytes?: number; error?: boolean }) => result.body
      && Number.isSafeInteger(result.sizeBytes) && result.sizeBytes! > 0 && result.sizeBytes! <= result.body.byteLength && result.sizeBytes! <= STUDIO_PSD_MAX_FILE_BYTES
      ? settle(undefined, result.body, result.sizeBytes) : settle(new StudioPsdEncodingError(422, "图层没有完整的透明内容，或 PSD 编码失败；原图与图层仍保留。")));
    worker.once("error", () => settle(new StudioPsdEncodingError(503, "PSD 导出进程暂不可用，请稍后重试。")));
    worker.once("exit", () => { if (!finished) settle(new StudioPsdEncodingError(503, "PSD 导出未完成，请稍后重试。")); });
    if (signal.aborted) abort();
  });
}
