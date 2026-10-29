import { createHash } from "node:crypto";
import sharp from "sharp";
import { STUDIO_LAYER_QUALITY_REVISION, STUDIO_LAYER_QUALITY_THRESHOLDS, StudioLayerQualityReport,
  type StudioLayerQualityUnavailableReason } from "@brandai/contracts";
import { artifactDeadline, STUDIO_ARTIFACT_MAX_BYTES } from "./studio-generation-artifacts-image";
import { assertStudioLayerBudget, STUDIO_LAYER_TOTAL_PIXELS } from "./studio-decomposition-images";
import { ApiException } from "./api";

type Source = { assetSha256: string; sourceWidth: number; sourceHeight: number; sourceSizeBytes: number; sourceMimeType: string };
type Pixels = { data: Buffer; width: number; height: number };
const formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** A bounded nearest-grid sample uses identical original-coordinate pixel
 * centres for source and every normalized layer. Unlike resizing each layer,
 * it does not filter RGB across alpha boundaries or move thin elements.
 * Small features between sampled pixels can be missed; this is triage only. */
export class StudioLayerQualityCheck {
  private source: Buffer | null = null;
  private composite: Float32Array | null = null;
  private reason: StudioLayerQualityUnavailableReason | null = null;
  private nextOrder = 0;
  private readonly sampleWidth: number;
  private readonly sampleHeight: number;
  private readonly warnings = new Set<StudioLayerQualityReport["warnings"][number]>();
  private readonly hashes = new Set<string>();
  private computeRemainingMs = 30_000;
  private computeDeadline = Infinity;

  constructor(private readonly expected: Source, private readonly layerCount: number, private readonly signal: AbortSignal) {
    const scale = Math.min(1, 1024 / Math.max(expected.sourceWidth, expected.sourceHeight));
    this.sampleWidth = Math.max(1, Math.floor(expected.sourceWidth * scale));
    this.sampleHeight = Math.max(1, Math.floor(expected.sourceHeight * scale));
  }
  get failureReason() { return this.reason; }
  private checkpoint() {
    this.signal.throwIfAborted();
    if (performance.now() > this.computeDeadline) { this.unavailable("CHECK_ABORTED"); throw new Error("Quality computation deadline"); }
  }
  private compute<T>(work: () => T): T {
    const started = performance.now(); this.computeDeadline = started + this.computeRemainingMs;
    try { this.checkpoint(); return work(); }
    finally { this.computeRemainingMs -= performance.now() - started; this.computeDeadline = Infinity; }
  }
  private sampled(pixels: Pixels): Buffer {
    if (pixels.width !== this.expected.sourceWidth || pixels.height !== this.expected.sourceHeight
      || pixels.data.length !== pixels.width * pixels.height * 4) throw new Error("Quality pixel frame mismatch");
    const sample = Buffer.alloc(this.sampleWidth * this.sampleHeight * 4);
    for (let y = 0; y < this.sampleHeight; y++) {
      this.checkpoint();
      const sourceY = Math.min(pixels.height - 1, Math.floor((y + 0.5) * pixels.height / this.sampleHeight));
      for (let x = 0; x < this.sampleWidth; x++) {
        const sourceX = Math.min(pixels.width - 1, Math.floor((x + 0.5) * pixels.width / this.sampleWidth));
        const offset = (sourceY * pixels.width + sourceX) * 4;
        sample.set(pixels.data.subarray(offset, offset + 4), (y * this.sampleWidth + x) * 4);
      }
    }
    return sample;
  }
  unavailable(reason: StudioLayerQualityUnavailableReason) {
    this.reason ??= reason;
    this.source = null; this.composite = null;
  }
  async initialize(loadSource: (signal: AbortSignal) => Promise<Buffer>, sourceSignal: AbortSignal = this.signal) {
    let body: Buffer;
    try { body = await artifactDeadline(loadSource(sourceSignal), sourceSignal); }
    catch (error) { this.unavailable(sourceSignal.aborted ? "CHECK_ABORTED" : error instanceof ApiException && error.status === 422 ? "SOURCE_INVALID" : "SOURCE_UNAVAILABLE"); return; }
    if (!Buffer.isBuffer(body) || !body.length || body.length > STUDIO_ARTIFACT_MAX_BYTES) { this.unavailable("SOURCE_INVALID"); return; }
    if (body.length !== this.expected.sourceSizeBytes || createHash("sha256").update(body).digest("hex") !== this.expected.assetSha256) {
      this.unavailable("SOURCE_MISMATCH"); return;
    }
    const image = sharp(body, { limitInputPixels: STUDIO_LAYER_TOTAL_PIXELS, failOn: "warning" });
    const abort = () => image.destroy();
    sourceSignal.addEventListener("abort", abort, { once: true });
    try {
      const metadata = await artifactDeadline(image.metadata(), sourceSignal);
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || !formats[metadata.format ?? ""]) {
        this.unavailable("SOURCE_INVALID"); return;
      }
      const rotated = (metadata.orientation ?? 0) >= 5;
      if ((rotated ? metadata.height : metadata.width) !== this.expected.sourceWidth
        || (rotated ? metadata.width : metadata.height) !== this.expected.sourceHeight
        || formats[metadata.format ?? ""] !== this.expected.sourceMimeType) { this.unavailable("SOURCE_MISMATCH"); return; }
      const decoded = await artifactDeadline(image.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }), sourceSignal);
      if (decoded.info.channels !== 4) { this.unavailable("SOURCE_INVALID"); return; }
      try {
        this.source = this.compute(() => this.sampled({ data: decoded.data, width: decoded.info.width, height: decoded.info.height }));
        // The composite starts fully transparent, never with the original below it.
        this.composite = new Float32Array(this.sampleWidth * this.sampleHeight * 4);
      } catch { this.unavailable(this.signal.aborted ? "CHECK_ABORTED" : "CHECK_FAILED"); }
    } catch { this.unavailable(sourceSignal.aborted ? "CHECK_ABORTED" : "SOURCE_INVALID"); }
    finally { sourceSignal.removeEventListener("abort", abort); image.destroy(); }
  }
  /** Called synchronously with the exact normalized RGBA used to encode each
   * archived PNG. Own failures never turn into a paid/provider retry. */
  addDecoded(pixels: Pixels, order: number) {
    if (this.reason) return;
    try {
      this.signal.throwIfAborted();
      if (!this.source || !this.composite || order !== this.nextOrder || order >= this.layerCount) throw new Error("Quality layer order mismatch");
      this.compute(() => {
        const layer = this.sampled(pixels);
        for (let offset = 0; offset < layer.length; offset += 4) {
          if (offset % 65_536 === 0) this.checkpoint();
          const alpha = layer[offset + 3]! / 255, inverse = 1 - alpha;
          for (let channel = 0; channel < 3; channel++) this.composite![offset + channel] = layer[offset + channel]! * alpha + this.composite![offset + channel]! * inverse;
          this.composite![offset + 3] = alpha + this.composite![offset + 3]! * inverse;
        }
      });
      this.nextOrder++;
    } catch { this.unavailable(this.signal.aborted ? "CHECK_ABORTED" : "CHECK_FAILED"); }
  }
  noteLayer(layer: { inkCoverage: number; assetSha256: string }) {
    if (layer.inkCoverage < 0.005) this.warnings.add("WEAK_LAYER");
    // Exact normalized-byte duplicates are a conservative subset of near duplicates.
    if (this.hashes.has(layer.assetSha256)) this.warnings.add("NEAR_DUPLICATE_LAYERS");
    this.hashes.add(layer.assetSha256);
  }
  finish(): StudioLayerQualityReport {
    let metrics: StudioLayerQualityReport["metrics"] = null;
    const regions: StudioLayerQualityReport["regions"] = [];
    let status: StudioLayerQualityReport["status"] = "UNAVAILABLE";
    try {
      this.signal.throwIfAborted();
      if (!this.reason) {
        if (!this.source || !this.composite || this.nextOrder !== this.layerCount) throw new Error("Incomplete quality composite");
        this.compute(() => {
        let colorError = 0, alphaError = 0, changed = 0;
        const totals = new Uint32Array(16), changes = new Uint32Array(16);
        for (let y = 0; y < this.sampleHeight; y++) {
          this.checkpoint();
          const sourceY = Math.min(this.expected.sourceHeight - 1, Math.floor((y + 0.5) * this.expected.sourceHeight / this.sampleHeight));
          for (let x = 0; x < this.sampleWidth; x++) {
            const sourceX = Math.min(this.expected.sourceWidth - 1, Math.floor((x + 0.5) * this.expected.sourceWidth / this.sampleWidth));
            const offset = (y * this.sampleWidth + x) * 4, sourceAlpha = this.source![offset + 3]! / 255;
            const alphaDifference = Math.abs(this.composite![offset + 3]! * 255 - this.source![offset + 3]!);
            let maximum = alphaDifference;
            for (let channel = 0; channel < 3; channel++) {
              const difference = Math.abs(this.composite![offset + channel]! - this.source![offset + channel]! * sourceAlpha);
              colorError += difference; maximum = Math.max(maximum, difference);
            }
            alphaError += alphaDifference;
            // Assign actual original pixel centres to the exact source boxes
            // below, including non-multiples of four and very narrow images.
            const cell = (Math.ceil((sourceY + 1) * 4 / this.expected.sourceHeight) - 1) * 4
              + Math.ceil((sourceX + 1) * 4 / this.expected.sourceWidth) - 1;
            totals[cell] = totals[cell]! + 1;
            if (maximum > STUDIO_LAYER_QUALITY_THRESHOLDS.changedChannelDelta) { changed++; changes[cell] = changes[cell]! + 1; }
          }
        }
        const count = this.sampleWidth * this.sampleHeight;
        metrics = { meanAbsoluteError: colorError / (count * 3), changedPixelRatio: changed / count, alphaMeanAbsoluteError: alphaError / count };
        for (let cell = 0; cell < 16; cell++) {
          if (!totals[cell] || changes[cell]! / totals[cell]! <= STUDIO_LAYER_QUALITY_THRESHOLDS.regionChangedPixelRatio) continue;
          const column = cell % 4, row = Math.floor(cell / 4);
          const left = Math.floor(column * this.expected.sourceWidth / 4), top = Math.floor(row * this.expected.sourceHeight / 4);
          regions.push({ left, top, width: Math.max(1, Math.floor((column + 1) * this.expected.sourceWidth / 4) - left),
            height: Math.max(1, Math.floor((row + 1) * this.expected.sourceHeight / 4) - top), changedPixelRatio: changes[cell]! / totals[cell]! });
        }
        if (metrics.meanAbsoluteError > STUDIO_LAYER_QUALITY_THRESHOLDS.meanAbsoluteError
          || metrics.changedPixelRatio > STUDIO_LAYER_QUALITY_THRESHOLDS.changedPixelRatio
          || metrics.alphaMeanAbsoluteError > STUDIO_LAYER_QUALITY_THRESHOLDS.alphaMeanAbsoluteError) this.warnings.add("COMPOSITE_DIFFERENCE");
        if (regions.length) this.warnings.add("LOCAL_DIFFERENCE");
        status = this.warnings.size ? "REVIEW_REQUIRED" : "COMPOSITE_MATCH";
        });
      }
    } catch { this.unavailable(this.signal.aborted ? "CHECK_ABORTED" : "CHECK_FAILED"); }
    if (this.reason) { metrics = null; regions.length = 0; status = "UNAVAILABLE"; this.warnings.add("QUALITY_CHECK_UNAVAILABLE"); }
    this.source = null; this.composite = null;
    const report = { revision: STUDIO_LAYER_QUALITY_REVISION, status,
      sourceSha256: this.expected.assetSha256, sourceWidth: this.expected.sourceWidth, sourceHeight: this.expected.sourceHeight,
      sampleWidth: metrics ? this.sampleWidth : null, sampleHeight: metrics ? this.sampleHeight : null, metrics, regions,
      warnings: [...this.warnings], unavailableReason: this.reason, thresholds: STUDIO_LAYER_QUALITY_THRESHOLDS,
      semanticsChecked: false as const, textChecked: false as const, humanReviewRequired: true as const, checkedAt: new Date().toISOString() };
    const parsed = StudioLayerQualityReport.safeParse(report);
    if (parsed.success) return parsed.data;
    // Even a computation/schema bug cannot promote success or discard valid
    // files. Only the safe fixed reason is exposed; no diagnostic content.
    return { ...report, status: "UNAVAILABLE", sampleWidth: null, sampleHeight: null, metrics: null, regions: [],
      warnings: ["QUALITY_CHECK_UNAVAILABLE"], unavailableReason: "CHECK_FAILED" };
  }
}

export async function createStudioLayerQualityCheck(source: Source, layerCount: number, signal: AbortSignal, loadSource: (signal: AbortSignal) => Promise<Buffer>) {
  assertStudioLayerBudget(source.sourceWidth, source.sourceHeight, layerCount);
  // Source I/O/decode has its own deadline. The cumulative 30s computation
  // budget excludes time spent downloading/uploading the individual layers.
  const check = new StudioLayerQualityCheck(source, layerCount, signal);
  try { await check.initialize(loadSource, AbortSignal.any([signal, AbortSignal.timeout(10_000)])); }
  catch { check.unavailable(signal.aborted ? "CHECK_ABORTED" : "CHECK_FAILED"); }
  return check;
}
