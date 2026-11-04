import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { checkBrandColourFidelity, colourFidelityMessage, deltaE, dominantColours, parseHex, toHex } from "../src/lib/brand-colour-fidelity";

/** Solid-colour PNG. */
async function solid(hex: string, width = 64, height = 64) {
  return sharp({ create: { width, height, channels: 3, background: hex } }).png().toBuffer();
}

/** Left half `a`, right half `b`. */
async function halves(a: string, b: string, width = 64, height = 64) {
  const left = await solid(a, width / 2, height);
  const right = await solid(b, width / 2, height);
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: width / 2, top: 0 },
    ])
    .png()
    .toBuffer();
}

describe("brand colour fidelity", () => {
  it("parses and normalises hex, rejecting garbage", () => {
    expect(parseHex("#7C5CFF")).toEqual([124, 92, 255]);
    expect(parseHex("7c5cff")).toEqual([124, 92, 255]);
    expect(parseHex("#abc")).toEqual([170, 187, 204]);
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("#gggggg")).toBeNull();
    expect(parseHex("")).toBeNull();
    expect(toHex([124, 92, 255])).toBe("#7c5cff");
  });

  it("measures perceptual distance, not raw channel distance", () => {
    // Same colour is zero; black vs white is maximal; a near-miss stays small.
    expect(deltaE([124, 92, 255], [124, 92, 255])).toBeCloseTo(0, 5);
    expect(deltaE([0, 0, 0], [255, 255, 255])).toBeGreaterThan(90);
    expect(deltaE([124, 92, 255], [120, 88, 250])).toBeLessThan(5);
    // Green vs red must be far apart — this is the whole point of the check.
    expect(deltaE([52, 168, 83], [220, 40, 40])).toBeGreaterThan(40);
  });

  it("reports dominant colours with their coverage share", async () => {
    const found = await dominantColours(await solid("#7c5cff"));
    expect(found[0]!.share).toBeGreaterThan(0.98);
    expect(deltaE(parseHex(found[0]!.hex)!, [124, 92, 255])).toBeLessThan(3);
  });

  it("passes when the palette colour is actually in the image", async () => {
    const result = await checkBrandColourFidelity({ palette: ["#7C5CFF"], image: await solid("#7c5cff") });
    expect(result.checked).toBe(true);
    expect(result.withinBrand).toBe(true);
    expect(result.present.map(entry => entry.hex)).toEqual(["#7C5CFF"]);
    expect(result.missing).toEqual([]);
    expect(colourFidelityMessage(result)).toBe("颜色抽样：检测到所有非中性品牌色的近似颜色。");
  });

  it("flags the reported defect: a green subject rendered red against a green palette", async () => {
    // The user-visible complaint: brand green is specified, the render is red.
    const result = await checkBrandColourFidelity({ palette: ["#34A853"], image: await solid("#DC2828") });
    expect(result.checked).toBe(true);
    expect(result.withinBrand).toBe(false);
    expect(result.missing).toEqual(["#34A853"]);
    expect(colourFidelityMessage(result)).toBe("颜色抽样：未检出足够的近似品牌色，请人工检查。");
  });

  it("reports which palette entries are missing when only some are used", async () => {
    const image = await halves("#7c5cff", "#ffffff");
    const result = await checkBrandColourFidelity({ palette: ["#7C5CFF", "#1B7F3A"], image });
    expect(result.checked).toBe(true);
    expect(result.present.map(entry => entry.hex)).toEqual(["#7C5CFF"]);
    expect(result.missing).toEqual(["#1B7F3A"]);
    expect(colourFidelityMessage(result)).toBe("颜色抽样：近似品牌色找到 1 个，1 个未检出。");
  });

  it("does not claim a near-white palette entry was used just because the image is white", async () => {
    // A soft lavender tint sits within ΔE of white, so any white background
    // would "satisfy" it. Counting that as a pass is the false positive this
    // check must not produce.
    const white = await solid("#ffffff");
    const tinted = await checkBrandColourFidelity({ palette: ["#F4F0FF"], image: white });
    expect(tinted.neutral).toEqual(["#F4F0FF"]);
    expect(tinted.present).toEqual([]);
    expect(tinted.missing).toEqual([]);
    expect(tinted.withinBrand).toBe(false);
    expect(colourFidelityMessage(tinted)).toBe("颜色抽样：品牌色均为中性色，无法据此判断是否遵循。");
  });

  it("ignores a palette colour that only covers a stray sliver", async () => {
    // 1 pixel of 256: a genuine stray pixel, below the presence floor.
    const base = await solid("#ffffff", 256, 256);
    const sliver = await solid("#7c5cff", 1, 1);
    const image = await sharp(base).composite([{ input: sliver, left: 0, top: 0 }]).png().toBuffer();
    const result = await checkBrandColourFidelity({ palette: ["#7C5CFF"], image });
    expect(result.present).toEqual([]);
    expect(result.missing).toEqual(["#7C5CFF"]);
  });

  it("never throws on unusable input", async () => {
    expect((await checkBrandColourFidelity({ palette: [], image: await solid("#ffffff") })).checked).toBe(false);
    const noReason = await checkBrandColourFidelity({ palette: ["not-a-colour"], image: await solid("#ffffff") });
    expect(noReason.checked).toBe(false);
    expect(noReason.reason).toBe("没有可核对的品牌颜色");
    const broken = await checkBrandColourFidelity({ palette: ["#7C5CFF"], image: Buffer.from("not an image") });
    expect(broken.checked).toBe(false);
    expect(broken.reason).toBe("图片无法读取，未做颜色核对");
    expect(colourFidelityMessage(broken)).toBe("");
  });

  it("honours a caller-supplied tolerance", async () => {
    const image = await solid("#8a6cff");
    const strict = await checkBrandColourFidelity({ palette: ["#7C5CFF"], image, maxDeltaE: 1 });
    const loose = await checkBrandColourFidelity({ palette: ["#7C5CFF"], image, maxDeltaE: 40 });
    expect(strict.withinBrand).toBe(false);
    expect(loose.withinBrand).toBe(true);
  });
});

it("finds a 0.75 percent patch below the dominant-colour reporting cutoff", async () => {
  const base = await solid("#ffffff", 96, 96);
  const patch = await solid("#7c5cff", 8, 9);
  const image = await sharp(base).composite([{ input: patch, left: 0, top: 0 }]).png().toBuffer();
  const result = await checkBrandColourFidelity({ palette: ["#7c5cff"], image });
  expect(result.present).toHaveLength(1);
  expect(result.present[0]!.share).toBeCloseTo(72 / 9216);
});
