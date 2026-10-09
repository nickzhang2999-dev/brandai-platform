import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/s3", () => ({ getObjectStream: vi.fn() }));
vi.mock("../../../apps/web/src/lib/ssrf", () => ({ safeFetch: vi.fn() }));
vi.mock("../../../apps/web/src/lib/watermark", () => ({ applyWatermarksToImage: vi.fn() }));
import { deriveStudioExactLayout } from "../../../apps/web/src/lib/studio-exact-geometry";
import { compositeStudioExactImage } from "../../../apps/web/src/lib/studio-exact-image";
const fixture = (name: string) => readFile(new URL(`./fixtures/studio-exact-native/${name}`, import.meta.url));

it("matches an actual native frame PNG pixel-for-pixel for saved group rotation, flips and overlap, including native reopen", async () => {
  const input = JSON.parse((await fixture("derive-input.json")).toString("utf8"));
  const sources = new Map<string, Buffer>([[input.references[0].assetId, await fixture("source-a.png")], [input.references[1].assetId, await fixture("source-b.png")]]);
  const layout = deriveStudioExactLayout(input);
  const base = await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const result = await compositeStudioExactImage(base, layout.layers, async id => {
    const body = sources.get(id); if (!body) throw Error("Fixture source identity mismatch");
    return { imageUrl: `data:image/png;base64,${body.toString("base64")}` };
  }, AbortSignal.timeout(5000));
  expect([result.width, result.height]).toEqual([128,128]);
  const actual = await sharp(result.body).ensureAlpha().raw().toBuffer();
  for (const name of ["native-frame.png", "native-frame-fresh.png"]) {
    const expected = await sharp(await fixture(name)).ensureAlpha().raw().toBuffer();
    expect(actual.equals(expected), `${name}: server derivation/composition must match original native rendering`).toBe(true);
  }
});

it("matches the selected-frame region while honestly differing from native overflow-expanded export bounds", async () => {
  const input = JSON.parse((await fixture("overflow/derive-input.json")).toString("utf8"));
  const sources = new Map<string, Buffer>([[input.references[0].assetId, await fixture("overflow/source-a.png")], [input.references[1].assetId, await fixture("overflow/source-b.png")]]);
  const layout = deriveStudioExactLayout(input);
  const base = await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const result = await compositeStudioExactImage(base, layout.layers, async id => ({ imageUrl: `data:image/png;base64,${sources.get(id)!.toString("base64")}` }), AbortSignal.timeout(5000));
  const native = await fixture("overflow/native-frame.png"), meta = await sharp(native).metadata();
  expect([meta.width, meta.height]).toEqual([140,140]); expect([result.width, result.height]).toEqual([128,128]);
  const expected = await sharp(native).extract({ left: 12, top: 0, width: 128, height: 128 }).ensureAlpha().raw().toBuffer();
  const actual = await sharp(result.body).ensureAlpha().raw().toBuffer();
  expect(actual.equals(expected), "fixed product frame must match its region in the actual larger native export").toBe(true);
});
