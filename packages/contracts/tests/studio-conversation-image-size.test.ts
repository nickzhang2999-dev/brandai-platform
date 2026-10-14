import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts-image", () => ({
  artifactDeadline: async (promise: Promise<unknown>, signal: AbortSignal) => { signal.throwIfAborted(); return promise; },
  inspectArtifactImage: async (body: Buffer, signal: AbortSignal) => { signal.throwIfAborted(); const image = await sharp(body).metadata(); return { width: image.width!, height: image.height!, mimeType: "image/png" }; },
}));
import { sizeStudioConversationImage } from "../../../apps/web/src/lib/studio-conversation-image-size";
describe("conversation actual output pixels", () => {
  it("returns a real 1080×1920 PNG from a provider square without a paid call", async () => {
    const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "red" } }).png().toBuffer();
    const result = await sizeStudioConversationImage(bytes, { width: 1080, height: 1920 }, AbortSignal.timeout(10_000));
    const actual = await sharp(result.body).metadata();
    expect([actual.width, actual.height]).toEqual([1080, 1920]); expect(actual.hasAlpha).toBe(true);
    expect(result.providerSize).toEqual({ width: 1024, height: 1024 }); expect(result.resized).toBe(true);
    const pixels = await sharp(result.body).raw().toBuffer({ resolveWithObject: true }); expect(pixels.data[3]).toBe(0);
  });
  it("preserves exact provider output bytes when already sized", async () => {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
    const result = await sizeStudioConversationImage(bytes, { width: 32, height: 32 }, AbortSignal.timeout(1000));
    expect(result.body).toBe(bytes); expect(result.resized).toBe(false);
  });
  it("rejects unbounded allocations and cancelled work", async () => {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
    await expect(sizeStudioConversationImage(bytes, { width: 8192, height: 8192 }, AbortSignal.timeout(1000))).rejects.toThrow();
    await expect(sizeStudioConversationImage(bytes, { width: 1080, height: 1920 }, AbortSignal.abort())).rejects.toThrow();
  });
});
