import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("../src/lib/studio-generation-artifacts-image", () => ({
  artifactDeadline: async (work: Promise<unknown>, signal: AbortSignal) => { signal.throwIfAborted(); return work; },
  inspectArtifactImage: async (body: Buffer, signal: AbortSignal) => {
    signal.throwIfAborted(); const image = await sharp(body).metadata();
    return { width: image.width!, height: image.height!, mimeType: "image/png" };
  },
}));
import { validateGptImage2Size } from "../../../packages/contracts/src/generation-size";
import { studioConversationProviderSize } from "../src/lib/studio-conversation-provider-size";
import { sizeStudioConversationImage } from "../src/lib/studio-conversation-image-size";

describe("dialog output size to model transport", () => {
  it.each([[1280, 720], [1024, 1024], [2560, 1440]])("keeps supported %i×%i unchanged", (width, height) => {
    expect(studioConversationProviderSize({ width, height })).toEqual({ width, height });
  });
  it.each([[1024, 576], [1080, 1920], [32, 32], [4096, 4096], [3840, 1280], [7000, 2334]])(
    "adapts %i×%i without changing the accepted output", (width, height) => {
      const requested = Object.freeze({ width, height });
      const actual = studioConversationProviderSize(requested);
      expect(validateGptImage2Size(actual.width, actual.height)).toBeNull();
      expect(Math.abs(actual.width / actual.height - width / height)).toBeLessThan(.02);
      expect(requested).toEqual({ width, height });
    });
  it("delivers the original 1024×576 pixels after a legal one-image model result", async () => {
    const requested = { width: 1024, height: 576 };
    const model = studioConversationProviderSize(requested);
    expect(model).toEqual({ width: 1280, height: 720 });
    const body = await sharp({ create: { ...model, channels: 3, background: "blue" } }).png().toBuffer();
    const result = await sizeStudioConversationImage(body, requested, AbortSignal.timeout(10_000));
    expect(result.resized).toBe(true);
    expect(result.providerSize).toEqual(model);
    expect(result.requestedSize).toEqual(requested);
    const pixels = await sharp(result.body).metadata();
    expect([pixels.width, pixels.height]).toEqual([1024, 576]);
  });
  it.each([[0, 100], [NaN, 512], [1024.5, 1024], [8192, 8192], [4096, 32]])(
    "rejects invalid output %i×%i before generation", (width, height) => {
      expect(() => studioConversationProviderSize({ width, height })).toThrow();
    });
});
