import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/s3", () => ({ getObjectStream: vi.fn() }));
vi.mock("../src/lib/ssrf", () => ({ safeFetch: vi.fn() }));
vi.mock("../src/lib/watermark", () => ({ applyWatermarksToImage: vi.fn() }));
import { createStudioLayerQualityCheck } from "../src/lib/studio-layer-quality";
import { inspectStudioLayer } from "../src/lib/studio-decomposition-images";
import { StudioLayerQualityReport } from "@brandai/contracts";

// Actual local RGBA/PNG decoding and composition; no AI, DB or paid calls.
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const signal = () => AbortSignal.timeout(15_000);
function pixels(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return data;
}
const png = (data: Buffer, width: number, height: number) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
async function check(source: Buffer, width: number, height: number, count = 2, overrides: Record<string, unknown> = {}, abort = signal()) {
  return createStudioLayerQualityCheck({ assetSha256: digest(source), sourceSizeBytes: source.length,
    sourceWidth: width, sourceHeight: height, sourceMimeType: "image/png", ...overrides }, count, abort, async () => source);
}
async function add(checker: Awaited<ReturnType<typeof check>>, bytes: Buffer, width: number, height: number, order: number) {
  const inspected = await inspectStudioLayer(bytes, width, height, signal(), undefined, rgba => checker.addDecoded(rgba, order));
  checker.noteLayer(inspected);
  return inspected;
}
async function split(width = 32, height = 32) {
  const color = [70, 90, 160, 255];
  return { source: await png(pixels(width, height, () => color), width, height),
    bottom: await png(pixels(width, height, x => x < width / 2 ? color : [0, 0, 0, 0]), width, height),
    top: await png(pixels(width, height, x => x >= width / 2 ? color : [0, 0, 0, 0]), width, height) };
}

describe("persisted layer pixel triage", () => {
  it("matches exact reconstruction from real normalized bytes without treating it as semantic/text approval", async () => {
    const { source, bottom, top } = await split(); const quality = await check(source, 32, 32);
    await add(quality, bottom, 32, 32, 0); await add(quality, top, 32, 32, 1);
    expect(quality.finish()).toMatchObject({ status: "COMPOSITE_MATCH", sourceSha256: digest(source), sampleWidth: 32, sampleHeight: 32,
      metrics: { meanAbsoluteError: 0, changedPixelRatio: 0, alphaMeanAbsoluteError: 0 }, regions: [],
      semanticsChecked: false, textChecked: false, humanReviewRequired: true });
  });
  it("flags a small changed region even when global difference is below the threshold", async () => {
    const { source, top } = await split(); const quality = await check(source, 32, 32);
    const changed = await png(pixels(32, 32, (x, y) => x >= 16 ? [0, 0, 0, 0] : x < 3 && y < 3 ? [255, 0, 0, 255] : [70, 90, 160, 255]), 32, 32);
    await add(quality, changed, 32, 32, 0); await add(quality, top, 32, 32, 1);
    const report = quality.finish();
    expect(report.status).toBe("REVIEW_REQUIRED"); expect(report.metrics!.changedPixelRatio).toBe(9 / 1024);
    expect(report.warnings).toContain("LOCAL_DIFFERENCE"); expect(report.warnings).not.toContain("COMPOSITE_DIFFERENCE");
    expect(report.regions).toEqual([{ left: 0, top: 0, width: 8, height: 8, changedPixelRatio: 9 / 64 }]);
  });
  it("does not hide holes by placing the source underneath the transparent composite", async () => {
    const { source, bottom } = await split(); const quality = await check(source, 32, 32);
    await add(quality, bottom, 32, 32, 0); await add(quality, bottom, 32, 32, 1);
    const report = quality.finish();
    expect(report.status).toBe("REVIEW_REQUIRED"); expect(report.metrics!.alphaMeanAbsoluteError).toBe(127.5);
    expect(report.metrics!.changedPixelRatio).toBe(.5); expect(report.warnings).toContain("NEAR_DUPLICATE_LAYERS");
  });
  it("keeps changed sample pixels inside the reported regions for dimensions not divisible by four", async () => {
    const width = 513, height = 5, black = [0, 0, 0, 255];
    const source = await png(pixels(width, height, () => black), width, height);
    const lower = await png(pixels(width, height, () => black), width, height);
    const top = await png(pixels(width, height, (x, y) => x >= 128 && x < 256 && y === 1 ? [255, 255, 255, 255] : [0, 0, 0, 0]), width, height);
    const quality = await check(source, width, height); await add(quality, lower, width, height, 0); await add(quality, top, width, height, 1);
    const report = quality.finish();
    expect(report.regions).toContainEqual({ left: 128, top: 1, width: 128, height: 1, changedPixelRatio: 1 });
    expect(report.regions.every(region => region.top === 1 && region.left === 128)).toBe(true);
  });
  it("does not spend the computation budget on time between layer downloads/uploads", async () => {
    const { source, bottom, top } = await split(); const quality = await check(source, 32, 32);
    const clock = vi.spyOn(performance, "now").mockReturnValue(60_000);
    try {
      await add(quality, bottom, 32, 32, 0); clock.mockReturnValue(120_000);
      await add(quality, top, 32, 32, 1); clock.mockReturnValue(180_000);
      expect(quality.finish().status).toBe("COMPOSITE_MATCH");
    } finally { clock.mockRestore(); }
  });
  it("composites translucent pixels in source-over order and detects a reversed layer stack", async () => {
    const source = await png(pixels(8, 8, () => [170, 0, 85, 192]), 8, 8);
    const blue = await png(pixels(8, 8, () => [0, 0, 255, 128]), 8, 8), red = await png(pixels(8, 8, () => [255, 0, 0, 128]), 8, 8);
    const good = await check(source, 8, 8); await add(good, blue, 8, 8, 0); await add(good, red, 8, 8, 1);
    expect(good.finish()).toMatchObject({ status: "COMPOSITE_MATCH", metrics: { changedPixelRatio: 0 } });
    const reversed = await check(source, 8, 8); await add(reversed, red, 8, 8, 0); await add(reversed, blue, 8, 8, 1);
    expect(reversed.finish()).toMatchObject({ status: "REVIEW_REQUIRED", metrics: { changedPixelRatio: 1 } });
  });
  it("ignores invisible RGB and preserves weak alpha in its measurements and archived pixels", async () => {
    const source = await png(pixels(8, 8, x => x < 4 ? [120, 70, 220, 3] : [255, 255, 255, 0]), 8, 8);
    const faint = await png(pixels(8, 8, x => x < 4 ? [120, 70, 220, 1] : [0, 0, 0, 0]), 8, 8);
    const second = await png(pixels(8, 8, x => x < 4 ? [120, 70, 220, 2] : [0, 0, 0, 0]), 8, 8);
    const quality = await check(source, 8, 8);
    const archived = await add(quality, faint, 8, 8, 0); await add(quality, second, 8, 8, 1);
    expect((await sharp(archived.body).raw().toBuffer())[3]).toBe(1);
    const report = quality.finish(); expect(report.warnings).toContain("WEAK_LAYER");
    expect(report.metrics!.alphaMeanAbsoluteError).toBeLessThan(.01); expect(report.metrics!.changedPixelRatio).toBe(0);
  });
  it("uses normalized source coordinates after provider resizing, and bounds large samples to 1024", async () => {
    const small = await split(16, 8), large = await split(2048, 1024);
    const quality = await check(large.source, 2048, 1024);
    await add(quality, small.bottom, 2048, 1024, 0); await add(quality, small.top, 2048, 1024, 1);
    const report = quality.finish(); expect(report).toMatchObject({ sourceWidth: 2048, sourceHeight: 1024, sampleWidth: 1024, sampleHeight: 512 });
    // Resampling each half introduces soft edges; measured, never trimmed away.
    expect(report.metrics!.meanAbsoluteError).toBeLessThan(3);
  });
  it.each(["hash", "size", "dimensions", "mime"])("refuses a source %s mismatch without inventing metrics", async kind => {
    const { source } = await split();
    const overrides = kind === "hash" ? { assetSha256: "a".repeat(64) } : kind === "size" ? { sourceSizeBytes: 1 }
      : kind === "dimensions" ? { sourceHeight: 31 } : { sourceMimeType: "image/jpeg" };
    const report = (await check(source, 32, 32, 2, overrides)).finish();
    expect(report).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "SOURCE_MISMATCH", metrics: null, sampleWidth: null, regions: [] });
  });
  it("records corrupt source and inaccessible storage as separate controlled reasons", async () => {
    const bad = Buffer.from("invalid raster"); expect((await check(bad, 8, 8)).finish().unavailableReason).toBe("SOURCE_INVALID");
    const quality = await createStudioLayerQualityCheck({ assetSha256: digest(bad), sourceSizeBytes: bad.length, sourceWidth: 8, sourceHeight: 8, sourceMimeType: "image/png" }, 2,
      signal(), async () => { throw new Error("https://private.invalid/source?token=sensitive"); });
    const report = quality.finish(); expect(report.unavailableReason).toBe("SOURCE_UNAVAILABLE"); expect(JSON.stringify(report)).not.toMatch(/private|token|sensitive/);
  });
  it("degrades a quality abort to unavailable and rejects out-of-order or missing callbacks", async () => {
    const { source, bottom } = await split(); const abort = new AbortController(); abort.abort(new Error("private detail"));
    expect((await check(source, 32, 32, 2, {}, abort.signal)).finish()).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "CHECK_ABORTED" });
    const missing = await check(source, 32, 32); expect(missing.finish().unavailableReason).toBe("CHECK_FAILED");
    const wrongOrder = await check(source, 32, 32); await add(wrongOrder, bottom, 32, 32, 1);
    expect(wrongOrder.finish().unavailableReason).toBe("CHECK_FAILED");
  });
  it("enforces the existing 40M whole-group budget before loading any source", async () => {
    const load = vi.fn(); await expect(createStudioLayerQualityCheck({ assetSha256: "a".repeat(64), sourceSizeBytes: 1,
      sourceWidth: 4000, sourceHeight: 4000, sourceMimeType: "image/png" }, 3, signal(), load)).rejects.toThrow(); expect(load).not.toHaveBeenCalled();
  });
  it("rejects reports that claim semantic approval or unavailable measurements", async () => {
    const { source } = await split(); const report = (await check(source, 32, 32)).finish();
    expect(StudioLayerQualityReport.safeParse({ ...report, semanticsChecked: true }).success).toBe(false);
    expect(StudioLayerQualityReport.safeParse({ ...report, sampleWidth: 32 }).success).toBe(false);
    expect(StudioLayerQualityReport.safeParse({ ...report, sourceUrl: "https://private.invalid" }).success).toBe(false);
    const matched = { ...report, status: "COMPOSITE_MATCH", unavailableReason: null, warnings: [], sampleWidth: 32, sampleHeight: 32,
      metrics: { meanAbsoluteError: 255, changedPixelRatio: 1, alphaMeanAbsoluteError: 255 } };
    expect(StudioLayerQualityReport.safeParse(matched).success).toBe(false);
  });
});
