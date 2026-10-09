import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ExactAssetTransform } from "../src/resource-usage";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/s3", () => ({ getObjectStream: vi.fn() }));
vi.mock("../../../apps/web/src/lib/ssrf", () => ({ safeFetch: vi.fn() }));
vi.mock("../../../apps/web/src/lib/watermark", () => ({ applyWatermarksToImage: vi.fn() }));
import { compositeStudioExactImage, type StudioExactLayer } from "../../../apps/web/src/lib/studio-exact-image";

const digest = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const deadline = () => AbortSignal.timeout(10_000);
const rgba = (body: Buffer) => sharp(body).ensureAlpha().raw().toBuffer();
const fill = (width: number, height: number, background = "#000000") => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const image = (width: number, height: number, values: number[]) => sharp(Buffer.from(values), { raw: { width, height, channels: 4 } }).png().toBuffer();
const source = (body: Buffer) => ({ imageUrl: `data:image/png;base64,${body.toString("base64")}` });
const transform = (patch: Partial<StudioExactLayer["transform"]> = {}) => ExactAssetTransform.parse({ xRatio: .5, yRatio: .5, widthRatio: 1, ...patch });
const layer = (body: Buffer, width: number, height: number, patch: Partial<StudioExactLayer["transform"]> = {}, assetId = "owned-asset"): StudioExactLayer => ({ assetId, sha256: digest(body), width, height, transform: transform(patch) });
const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255], white = [255, 255, 255, 255], black = [0, 0, 0, 255];

describe("bounded product EXACT compositor (real local pixels, no provider)", () => {
  it("preserves opaque identity pixels and reports actual decoded output metadata", async () => {
    const pixels = [...red, ...green, ...blue, ...white];
    const bytes = await image(2, 2, pixels), base = await fill(2, 2);
    const load = vi.fn(async () => source(bytes));
    const result = await compositeStudioExactImage(base, [layer(bytes, 2, 2)], load, deadline());
    expect(await rgba(result.body)).toEqual(Buffer.from(pixels));
    expect(result).toMatchObject({ width: 2, height: 2, mimeType: "image/png", sha256: digest(result.body), sizeBytes: result.body.length, appliedAssetIds: ["owned-asset"] });
    expect(load).toHaveBeenCalledWith("owned-asset");
    expect(Object.keys(result).sort()).toEqual(["body", "width", "height", "mimeType", "sha256", "sizeBytes", "appliedAssetIds"].sort());
  });

  it("stacks by zIndex instead of callback/input order", async () => {
    const r = await fill(2, 2, "#ff0000"), b = await fill(2, 2, "#0000ff");
    const result = await compositeStudioExactImage(await fill(2, 2), [layer(b, 2, 2, { zIndex: 4 }, "blue"), layer(r, 2, 2, { zIndex: -1 }, "red")], async id => source(id === "red" ? r : b), deadline());
    expect(await rgba(result.body)).toEqual(Buffer.from([...blue, ...blue, ...blue, ...blue]));
    expect(result.appliedAssetIds).toEqual(["red", "blue"]);
  });

  it("flips horizontally without swapping rows", async () => {
    const bytes = await image(2, 2, [...red, ...green, ...blue, ...white]);
    const result = await compositeStudioExactImage(await fill(2, 2), [layer(bytes, 2, 2, { flipX: true })], async () => source(bytes), deadline());
    expect(await rgba(result.body)).toEqual(Buffer.from([...green, ...red, ...white, ...blue]));
  });

  it("rotates clockwise around the full-source center", async () => {
    const bytes = await image(2, 2, [...red, ...green, ...blue, ...white]);
    const result = await compositeStudioExactImage(await fill(2, 2), [layer(bytes, 2, 2, { rotationDeg: 90 })], async () => source(bytes), deadline());
    expect(await rgba(result.body)).toEqual(Buffer.from([...blue, ...red, ...white, ...green]));
  });

  it("clips a partially outside layer using source pixels, without rescaling it", async () => {
    const bytes = await image(4, 1, [...red, ...green, ...blue, ...white]);
    const result = await compositeStudioExactImage(await fill(4, 1), [layer(bytes, 4, 1, { xRatio: 0 })], async () => source(bytes), deadline());
    expect(await rgba(result.body)).toEqual(Buffer.from([...blue, ...white, ...black, ...black]));
  });

  it("keeps crop as a transparent mask at the original full-width anchor", async () => {
    const bytes = await fill(4, 1, "#ff0000");
    const result = await compositeStudioExactImage(await fill(4, 1), [layer(bytes, 4, 1, { crop: { left: .5, top: 0, right: 0, bottom: 0 } })], async () => source(bytes), deadline());
    expect(await rgba(result.body)).toEqual(Buffer.from([...black, ...black, ...red, ...red]));
  });

  it("fails closed for a fully outside source", async () => {
    const bytes = await fill(4, 1);
    await expect(compositeStudioExactImage(bytes, [layer(bytes, 4, 1, { xRatio: 1.5 })], async () => source(bytes), deadline())).rejects.toMatchObject({ status: 422 });
  });

  it("normalizes EXIF before composition and verifies upright source dimensions", async () => {
    const bytes = await sharp(await image(3, 2, [...red, ...red, ...red, ...blue, ...blue, ...blue])).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).withMetadata({ orientation: 6 }).toBuffer();
    const result = await compositeStudioExactImage(await fill(2, 3), [layer(bytes, 2, 3)], async () => ({ imageUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` }), deadline());
    expect(await rgba(result.body)).toEqual(await sharp(bytes).rotate().ensureAlpha().raw().toBuffer());
    expect(result).toMatchObject({ width: 2, height: 3 });
    expect((await sharp(result.body).metadata()).orientation).toBeUndefined();
    const baseOnly = await compositeStudioExactImage(bytes, [], async () => { throw new Error("must not load"); }, deadline());
    expect(baseOnly).toMatchObject({ width: 2, height: 3, appliedAssetIds: [] });
  });

  it("rejects SHA mismatch or stale source dimensions", async () => {
    const bytes = await fill(2, 2), base = await fill(2, 2);
    for (const changed of [{ ...layer(bytes, 2, 2), sha256: "a".repeat(64) }, layer(bytes, 1, 2)]) {
      await expect(compositeStudioExactImage(base, [changed], async () => source(bytes), deadline())).rejects.toMatchObject({ status: 422 });
    }
  });

  it("rejects malformed image bytes and invalid geometry without accepting hints", async () => {
    const broken = Buffer.from("not an image"), base = await fill(2, 2);
    await expect(compositeStudioExactImage(base, [layer(broken, 2, 2)], async () => source(broken), deadline())).rejects.toMatchObject({ status: 422 });
    const load = vi.fn();
    await expect(compositeStudioExactImage(base, [{ ...layer(base, 2, 2), transform: { ...transform(), widthRatio: Infinity } }], load, deadline())).rejects.toMatchObject({ status: 422 });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects huge thin-source resize intermediates before allocating them", async () => {
    const thin = await fill(1, 5000);
    await expect(compositeStudioExactImage(await fill(100, 100), [layer(thin, 1, 5000)], async () => source(thin), deadline())).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a rotation whose bounding box exceeds the intermediate pixel budget", async () => {
    const bytes = await fill(2, 4);
    // Resize -> 4000x8000 is valid; 45 degree rotation -> ~8486x8486 is not.
    await expect(compositeStudioExactImage(await fill(4000, 2), [layer(bytes, 2, 4, { rotationDeg: 45 })], async () => source(bytes), deadline())).rejects.toMatchObject({ status: 422 });
  });

  it("rejects oversized aggregate inputs and excessive layers", async () => {
    const small = await fill(1, 1), padded = Buffer.concat([small, Buffer.alloc(17 * 1024 * 1024)]);
    await expect(compositeStudioExactImage(padded, [layer(padded, 1, 1)], async () => source(padded), deadline())).rejects.toMatchObject({ status: 422 });
    const load = vi.fn();
    await expect(compositeStudioExactImage(small, Array.from({ length: 33 }, () => layer(small, 1, 1)), load, deadline())).rejects.toMatchObject({ status: 422 });
    expect(load).not.toHaveBeenCalled();
  });

  it("observes a stalled loader through the deadline and never starts with an aborted signal", async () => {
    const bytes = await fill(1, 1), controller = new AbortController(), load = vi.fn();
    controller.abort(new Error("stopped"));
    await expect(compositeStudioExactImage(bytes, [layer(bytes, 1, 1)], load, controller.signal)).rejects.toThrow("stopped");
    expect(load).not.toHaveBeenCalled();
    const running = new AbortController();
    const blocked = vi.fn(() => { setTimeout(() => running.abort(new Error("deadline")), 5); return new Promise<{ imageUrl: string }>(() => {}); });
    await expect(compositeStudioExactImage(bytes, [layer(bytes, 1, 1)], blocked, running.signal)).rejects.toThrow("deadline");
  });
});
