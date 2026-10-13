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

// ag-psd allocates decoded channels, a growing writer buffer, a temporary RLE
// buffer and composite bytes. Budget their worst-case copies, not PNG size.
export function assertStudioPsdBudget(width: number, height: number, count: number) {
  if (![width, height, count].every(Number.isSafeInteger) || width < 1 || height < 1 || width > 16384 || height > 16384 || count < 2 || count > 10
    || width * height * 4 * (count + 3) * 3 > STUDIO_PSD_MAX_MEMORY_BYTES) {
    throw new StudioPsdEncodingError(422, "图层组超过 PSD 导出内存上限，请降低原图尺寸后重新分层；不会丢层、缩小或裁切当前结果。");
  }
}

/** A constant, trusted program: neither layer names nor metadata are executed.
 * Actual synchronous PSD encoding runs outside Next's request event loop, so
 * a request deadline/client disconnect can terminate even the RLE writer. */
const writerProgram = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { writePsd } = require(workerData.modulePath);
try {
  const { width, height, layers, maxBytes } = workerData;
  const composite = new Uint8ClampedArray(width * height * 4);
  let hasTransparency = false;
  const children = [];
  for (const layer of layers) {
    const rgba = new Uint8ClampedArray(layer.pixels);
    let hasInk = false;
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = rgba[i + 3];
      if (alpha < 255) hasTransparency = true;
      if (alpha >= 64) hasInk = true;
      if (!alpha) continue;
      const a = alpha / 255;
      const previous = composite[i + 3] / 255;
      const outputAlpha = a + previous * (1 - a);
      for (let channel = 0; channel < 3; channel++) {
        composite[i + channel] = Math.round((rgba[i + channel] * a + composite[i + channel] * previous * (1 - a)) / outputAlpha);
      }
      composite[i + 3] = Math.round(outputAlpha * 255);
    }
    if (!hasInk) throw new Error('empty-layer');
    children.push({ name: layer.name, left: 0, top: 0, blendMode: 'normal', opacity: 1, hidden: false,
      imageData: { width, height, data: rgba } });
  }
  if (!hasTransparency) throw new Error('no-transparency');
  // Studio order=0 is the background; ag-psd children are top-to-bottom.
  const body = writePsd({ width, height, children: children.reverse(), imageData: { width, height, data: composite } },
    { noBackground: true, trimImageData: false, generateThumbnail: false });
  if (body.byteLength > maxBytes) throw new Error('file-budget');
  parentPort.postMessage({ body }, [body]);
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
  const decoded: Array<{ name: string; pixels: ArrayBuffer }> = [];
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
      // A dedicated transferable prevents a pooled Buffer from cloning a much
      // larger underlying slab; main-thread copies are released on transfer.
      const pixels = new ArrayBuffer(raw.data.length);
      new Uint8Array(pixels).set(raw.data);
      decoded.push({ name: (layer.name ?? `图层 ${layer.order + 1}`).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80), pixels });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof StudioPsdEncodingError) throw error;
      throw new StudioPsdEncodingError(422, "图层图片损坏，未导出 PSD。");
    } finally { signal.removeEventListener("abort", abort); image.destroy(); }
  }
  signal.throwIfAborted();
  const modulePath = createRequire(import.meta.url).resolve("ag-psd");
  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(writerProgram, {
      eval: true, workerData: { width, height, layers: decoded, maxBytes: STUDIO_PSD_MAX_FILE_BYTES, modulePath },
      transferList: decoded.map(layer => layer.pixels), resourceLimits: { maxOldGenerationSizeMb: 160, maxYoungGenerationSizeMb: 16 },
    });
    let finished = false;
    const cleanup = () => { signal.removeEventListener("abort", abort); return worker.terminate().catch(() => undefined); };
    const settle = (error?: unknown, body?: ArrayBuffer) => {
      if (finished) return; finished = true;
      // Keep the service's single-export slot until the thread has actually
      // stopped and released its decoded buffers, including on cancellation.
      void cleanup().then(() => { if (error) reject(error); else resolve(Buffer.from(body!)); });
    };
    const abort = () => settle(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: { body?: ArrayBuffer; error?: boolean }) => result.body
      ? settle(undefined, result.body) : settle(new StudioPsdEncodingError(422, "图层没有完整的透明内容，或 PSD 编码失败；原图与图层仍保留。")));
    worker.once("error", () => settle(new StudioPsdEncodingError(503, "PSD 导出进程暂不可用，请稍后重试。")));
    worker.once("exit", () => { if (!finished) settle(new StudioPsdEncodingError(503, "PSD 导出未完成，请稍后重试。")); });
    if (signal.aborted) abort();
  });
}
