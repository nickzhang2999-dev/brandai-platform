import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ get: vi.fn(), fetch: vi.fn(), compose: vi.fn() }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/s3", () => ({ getObjectStream: f.get }));
vi.mock("../../../apps/web/src/lib/ssrf", () => ({ safeFetch: f.fetch }));
vi.mock("../../../apps/web/src/lib/watermark", () => ({ applyWatermarksToImage: f.compose }));
import { artifactDataBytes, artifactDeadline, artifactOwnObjectKey, inspectArtifactImage, postprocessArtifactImage, readArtifactImageBytes, STUDIO_ARTIFACT_MAX_BYTES } from "../../../apps/web/src/lib/studio-generation-artifacts-image";

const image = () => sharp({ create: { width: 48, height: 32, channels: 4, background: "#7965ee" } }).png().toBuffer();
const signal = () => AbortSignal.timeout(3000);
beforeEach(() => vi.resetAllMocks());

describe("archive image boundary (local image fixtures, no provider calls)", () => {
  it("uses actual fully decoded bytes, MIME, dimensions and SHA", async () => {
    const bytes = await image();
    expect(artifactDataBytes(`data:image/png;base64,${bytes.toString("base64")}`)).toEqual(bytes);
    expect(await inspectArtifactImage(bytes, signal())).toEqual({ mimeType: "image/png", width: 48, height: 32, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await expect(inspectArtifactImage(bytes.subarray(0, 40), signal())).rejects.toMatchObject({ status: 422 });
    await expect(inspectArtifactImage(Buffer.from("not an image"), signal())).rejects.toMatchObject({ status: 422 });
  });
  it("rejects active, noncanonical, unsupported and oversized data URLs before decode", () => {
    for (const value of ["data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;utf8,abcd", "data:image/png;base64,AA", "data:image/png;base64,AB==", "data:image/png;base64,AA==\n", "data:image/png;base64,", "data:text/html;base64,AAAA"]) expect(() => artifactDataBytes(value)).toThrow();
    expect(() => artifactDataBytes("data:image/png;base64," + "A".repeat(Math.ceil(STUDIO_ARTIFACT_MAX_BYTES / 3) * 4 + 100))).toThrow();
  });
  it("derives own S3 keys only from the exact configured prefix, without decoding traversal", () => {
    expect(artifactOwnObjectKey("http://private.invalid/bucket/w/a", "http://private.invalid/bucket/")).toBe("w/a");
    expect(artifactOwnObjectKey("http://private.invalid/bucket/generations/w/a", "http://private.invalid/bucket", "w")).toBe("generations/w/a");
    expect(() => artifactOwnObjectKey("http://private.invalid/bucket/another/a", "http://private.invalid/bucket", "w")).toThrow();
    for (const value of ["https://evil.invalid/bucket/w/a", "http://private.invalid/bucket2/w/a", "http://private.invalid/bucket/../w/a", "http://private.invalid/bucket/w/%2e%2e/a", "http://private.invalid/bucket/w/a?signature=x"]) expect(artifactOwnObjectKey(value, "http://private.invalid/bucket")).toBeNull();
  });
  it("reads a known own object through S3 even with a private display URL", async () => {
    const bytes = await image(); f.get.mockResolvedValue({ body: Readable.from(bytes), contentLength: bytes.length });
    expect(await readArtifactImageBytes({ imageUrl: "http://private.invalid/a", objectKey: "w/key" }, signal())).toEqual(bytes);
    expect(f.get).toHaveBeenCalledWith("w/key", expect.any(AbortSignal)); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("routes external URLs through safeFetch with bounded redirects and checks actual bytes", async () => {
    const bytes = await image(); f.fetch.mockResolvedValue(new Response(bytes));
    expect(await readArtifactImageBytes({ imageUrl: "https://provider.invalid/signed" }, signal())).toEqual(bytes);
    expect(f.fetch).toHaveBeenCalledWith("https://provider.invalid/signed", 4, expect.any(AbortSignal));
    f.fetch.mockRejectedValueOnce(new Error("blocked private redirect"));
    await expect(readArtifactImageBytes({ imageUrl: "https://provider.invalid/redirect" }, signal())).rejects.toThrow("blocked private redirect");
  });
  it("rejects oversized declared objects without reading and never awaits broken cancellation", async () => {
    const body = new Readable({ read() {} }); f.get.mockResolvedValue({ body, contentLength: STUDIO_ARTIFACT_MAX_BYTES + 1 });
    await expect(readArtifactImageBytes({ imageUrl: "http://private.invalid/a", objectKey: "key" }, signal())).rejects.toMatchObject({ status: 422 }); expect(body.destroyed).toBe(true);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    f.fetch.mockResolvedValue({ ok: false, body: { cancel }, headers: new Headers() });
    await expect(readArtifactImageBytes({ imageUrl: "https://provider.invalid/a" }, signal())).rejects.toMatchObject({ status: 422 }); expect(cancel).toHaveBeenCalled();
  });
  it("bounds chunked object reads and a stalled network stream", async () => {
    f.get.mockResolvedValue({ body: Readable.from([Buffer.alloc(STUDIO_ARTIFACT_MAX_BYTES), Buffer.from([1])]) });
    await expect(readArtifactImageBytes({ imageUrl: "ignored", objectKey: "key" }, signal())).rejects.toThrow("limit");
    let cancelled = false;
    f.fetch.mockResolvedValue(new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } })));
    await expect(readArtifactImageBytes({ imageUrl: "https://provider.invalid/stall" }, AbortSignal.timeout(10))).rejects.toThrow(); expect(cancelled).toBe(true);
  });
  it("observes late adapter rejection even when the signal was already aborted", async () => {
    const controller = new AbortController(); controller.abort(new Error("already stopped"));
    let reject!: (reason: Error) => void;
    const started = new Promise<void>((_, no) => { reject = no; });
    await expect(artifactDeadline(started, controller.signal)).rejects.toThrow("already stopped");
    reject(new Error("late adapter failure")); await new Promise(resolve => setTimeout(resolve, 5));
  });
  it("bounds adapters ignoring abort and prevents arbitrary snapshot asset URLs entering the compositor", async () => {
    await expect(artifactDeadline(new Promise(() => {}), AbortSignal.timeout(10))).rejects.toThrow();
    const bytes = await image(), data = `data:image/png;base64,${bytes.toString("base64")}`;
    const load = vi.fn().mockResolvedValue({ imageUrl: data });
    f.compose.mockResolvedValue({ imageUrl: data, appliedAssetIds: ["logo"] });
    const result = await postprocessArtifactImage(bytes, [{ assetId: "logo", enabled: true, assetUrl: "http://127.0.0.1/private" }], load, signal(), { logo: createHash("sha256").update(bytes).digest("hex") });
    expect(result.width).toBe(48); expect(load).toHaveBeenCalledWith("logo");
    expect(f.compose.mock.calls[0][1][0].assetUrl).toBe(data); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("requires real successful logo application and refuses invalid snapshots", async () => {
    const bytes = await image(), data = `data:image/png;base64,${bytes.toString("base64")}`;
    f.compose.mockResolvedValue({ imageUrl: data, appliedAssetIds: [] });
    await expect(postprocessArtifactImage(bytes, [{ assetId: "logo", enabled: true }], async () => ({ imageUrl: data }), signal(), { logo: createHash("sha256").update(bytes).digest("hex") })).rejects.toMatchObject({ status: 422 });
    await expect(postprocessArtifactImage(bytes, "not overlays", async () => ({ imageUrl: data }), signal())).rejects.toMatchObject({ status: 422 });
  });
  it("requires the server's pre-provider logo digest and refuses mutable source replacement", async () => {
    const bytes = await image(); const load = vi.fn().mockResolvedValue({ imageUrl: `data:image/png;base64,${bytes.toString("base64")}` });
    for (const hashes of [undefined, {}, { logo: "invalid" }]) {
      await expect(postprocessArtifactImage(bytes, [{ assetId: "logo" }], load, signal(), hashes)).rejects.toMatchObject({ status: 422 });
    }
    expect(load).not.toHaveBeenCalled();
    await expect(postprocessArtifactImage(bytes, [{ assetId: "logo" }], load, signal(), { logo: "0".repeat(64) })).rejects.toMatchObject({ status: 422 });
    expect(f.compose).not.toHaveBeenCalled();
  });
  it("runs the real deterministic compositor entirely with local PNG bytes", async () => {
    const real = await vi.importActual<typeof import("../../../apps/web/src/lib/watermark")>("../../../apps/web/src/lib/watermark");
    f.compose.mockImplementation(real.applyWatermarksToImage);
    const bytes = await image(); const logo = await sharp({ create: { width: 5, height: 5, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const result = await postprocessArtifactImage(bytes, [{ assetId: "logo", enabled: true, widthPx: 8, anchor: "top-left", offsetX: 0, offsetY: 0 }], async () => ({ imageUrl: `data:image/png;base64,${logo.toString("base64")}` }), signal(), { logo: createHash("sha256").update(logo).digest("hex") });
    expect(result.appliedAssetIds).toEqual(["logo"]); expect(result.body.equals(bytes)).toBe(false); expect(result.width).toBe(48); expect(f.fetch).not.toHaveBeenCalled();
  });
});
