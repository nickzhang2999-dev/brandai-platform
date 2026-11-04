import sharp from "sharp";

/**
 * Post-hoc brand colour fidelity check.
 *
 * Brand rules reach the image model as *prompt text* (`ai-constraints.ts` folds
 * `structured.palette` into `promptAdditions`), so the model can ignore them —
 * a green apple can come back red even though the rule was loaded and applied.
 * Nothing here can prevent that. What this module does is make the deviation
 * visible after the fact, so "the rule was applied" stops being an unchecked
 * claim.
 *
 * The comparison is deliberately coarse: the goal is to answer "is any part of
 * the brand palette actually present in this image?" — not to audit exact hex
 * values, which would fail on every gradient, shadow and JPEG artefact.
 */

/** Maximum pixel count analysed. The image is downscaled first, so this is a
 * hard bound on the work regardless of the source resolution. */
const SAMPLE_EDGE = 96;
/** Quantisation buckets per channel (4 bits => 4096 buckets). Coarse enough
 * that photographic noise lands in the same bucket as its neighbours. */
const BUCKETS_PER_CHANNEL = 16;
/** A palette colour must cover at least this share of sampled pixels to count
 * as present. Filters out single stray pixels that happen to hit the bucket. */
const MIN_PRESENCE_SHARE = 0.005;
/** CIE76 ΔE below which a detected colour is considered the palette colour.
 * ~22 is a loose "same hue family" bound; brand palettes are recognisable by
 * hue, and stricter thresholds reject legitimate renders. */
const DEFAULT_MAX_DELTA_E = 22;
/** Detected colours below this share are ignored when building the report. */
const MIN_REPORTED_SHARE = 0.01;
/** A palette colour this close to white or black is a neutral tint. It appears
 * in any ordinary render, so counting it as "the brand colour was used" would
 * be a false pass — exactly the overclaiming this check exists to stop. Such
 * entries are reported as `neutral` and excluded from the verdict. */
const NEUTRAL_DELTA_E = 10;

export type ColourFidelityInput = {
  /** Brand palette as `#RRGGBB` (or `#RGB`). Invalid entries are skipped. */
  palette: string[];
  image: Buffer;
  /** CIE76 ΔE threshold; defaults to 22. */
  maxDeltaE?: number;
};

export type ColourFidelityResult = {
  /** False when there was nothing to check (no usable palette, unreadable image). */
  checked: boolean;
  /** Why the check did not run, when `checked` is false. */
  reason?: string;
  /** Palette entries found in the image, with the share of pixels they cover. */
  present: Array<{ hex: string; share: number; closestDetected: string; deltaE: number }>;
  /** Palette entries the image does not contain. These are the deviations. */
  missing: string[];
  /** Palette entries too close to white/black to prove anything either way. */
  neutral: string[];
  /** Dominant colours actually found, most common first. */
  detected: Array<{ hex: string; share: number }>;
  /** True when at least one diagnostic palette colour is present. */
  withinBrand: boolean;
};

type Rgb = [number, number, number];

const clamp255 = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

/** `#abc` / `#aabbcc` (case-insensitive, `#` optional) -> RGB. Null when invalid. */
export function parseHex(input: string): Rgb | null {
  const raw = input.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(raw)) return null;
  const full = raw.length === 3 ? raw.split("").map(c => c + c).join("") : raw;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

export function toHex(rgb: Rgb): string {
  return "#" + rgb.map(c => clamp255(c).toString(16).padStart(2, "0")).join("");
}

/** sRGB -> CIE Lab (D65). Used only for perceptual distance, never for output. */
function rgbToLab([r, g, b]: Rgb): [number, number, number] {
  const linear = (channel: number) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [linear(r), linear(g), linear(b)];
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.0;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE — euclidean distance in Lab. Coarse but stable and dependency-free. */
export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = rgbToLab(a);
  const [l2, a2, b2] = rgbToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Extract dominant colours from an image buffer.
 *
 * Downscales to a fixed edge, removes alpha against white, quantises each
 * channel to 4 bits and counts buckets. Returns buckets covering at least
 * `MIN_REPORTED_SHARE` of the sampled pixels, most common first.
 */
export async function dominantColours(image: Buffer, maxColours = 8): Promise<Array<{ hex: string; share: number }>> {
  const { data, info } = await sharp(image, { failOn: "warning" })
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: "inside", withoutEnlargement: true })
    // Flatten transparency onto white: a transparent PNG must not read as black.
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const total = Math.floor(data.length / channels);
  if (!total) return [];
  const counts = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let index = 0; index < total; index += 1) {
    const offset = index * channels;
    const r = data[offset]!;
    const g = data[offset + 1]!;
    const b = data[offset + 2]!;
    // Bucket by high nibble; keep a running mean so the reported hex is the
    // bucket's actual centre rather than the bucket corner.
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const entry = counts.get(key);
    if (entry) { entry.count += 1; entry.r += r; entry.g += g; entry.b += b; }
    else counts.set(key, { count: 1, r, g, b });
  }
  return [...counts.values()]
    .map(entry => ({
      hex: toHex([entry.r / entry.count, entry.g / entry.count, entry.b / entry.count]),
      share: entry.count / total,
    }))
    .filter(entry => entry.share >= MIN_REPORTED_SHARE)
    .sort((left, right) => right.share - left.share)
    .slice(0, maxColours);
}

/**
 * Compare an image against a brand palette.
 *
 * Never throws on bad input: an unreadable image or an empty palette yields
 * `checked: false` with a reason, because this runs on results the user already
 * paid for — a failed check must not turn a usable image into an error.
 */
export async function checkBrandColourFidelity(input: ColourFidelityInput): Promise<ColourFidelityResult> {
  const empty: ColourFidelityResult = { checked: false, present: [], missing: [], neutral: [], detected: [], withinBrand: false };
  const palette = input.palette
    .map(hex => ({ hex: hex.trim(), rgb: parseHex(hex) }))
    .filter((entry): entry is { hex: string; rgb: Rgb } => entry.rgb !== null);
  if (!palette.length) return { ...empty, reason: "没有可核对的品牌颜色" };
  if (!input.image?.length) return { ...empty, reason: "没有可核对的图片" };

  let detected: Array<{ hex: string; share: number }>;
  try {
    detected = await dominantColours(input.image);
  } catch {
    return { ...empty, reason: "图片无法读取，未做颜色核对" };
  }
  if (!detected.length) return { ...empty, reason: "图片没有可识别的颜色" };

  const threshold = input.maxDeltaE ?? DEFAULT_MAX_DELTA_E;
  const present: ColourFidelityResult["present"] = [];
  const missing: string[] = [];
  const neutral: string[] = [];
  for (const entry of palette) {
    // Near-white / near-black entries match any ordinary background, so a hit
    // proves nothing. Reporting them either way would mislead.
    if (deltaE(entry.rgb, [255, 255, 255]) <= NEUTRAL_DELTA_E || deltaE(entry.rgb, [0, 0, 0]) <= NEUTRAL_DELTA_E) {
      neutral.push(entry.hex);
      continue;
    }
    let best: { hex: string; share: number; deltaE: number } | null = null;
    for (const candidate of detected) {
      const rgb = parseHex(candidate.hex);
      if (!rgb) continue;
      // Skip neutral detected buckets too: white background must not satisfy
      // a saturated palette entry through a loose threshold.
      if (deltaE(rgb, [255, 255, 255]) <= NEUTRAL_DELTA_E || deltaE(rgb, [0, 0, 0]) <= NEUTRAL_DELTA_E) continue;
      const distance = deltaE(entry.rgb, rgb);
      if (!best || distance < best.deltaE) best = { hex: candidate.hex, share: candidate.share, deltaE: distance };
    }
    // Presence needs both a close colour and enough coverage: a 1-pixel hit in
    // a large render is noise, not the brand colour being used.
    if (best && best.deltaE <= threshold && best.share >= MIN_PRESENCE_SHARE) {
      present.push({ hex: entry.hex, share: best.share, closestDetected: best.hex, deltaE: Math.round(best.deltaE * 10) / 10 });
    } else {
      missing.push(entry.hex);
    }
  }

  return { checked: true, present, missing, neutral, detected, withinBrand: present.length > 0 };
}

/** One short Chinese sentence for the result card. Empty when nothing to say. */
export function colourFidelityMessage(result: ColourFidelityResult): string {
  if (!result.checked) return "";
  if (result.withinBrand) {
    return result.missing.length
      ? `颜色核对：品牌色找到 ${result.present.length} 个，${result.missing.length} 个未出现。`
      : "颜色核对：品牌色均已出现。";
  }
  // Only neutrals in the palette: there is no diagnostic colour to judge by.
  if (result.neutral.length && !result.missing.length) return "颜色核对：品牌色均为中性色，无法据此判断是否遵循。";
  return "颜色核对：未检测到任何品牌色，模型可能未遵循颜色规范。";
}

/**
 * Hexes declared by the workspace's confirmed `color` rules.
 *
 * Mirrors the shape `ai-constraints.ts` reads when it folds `structured.palette`
 * into the prompt, so the check judges against exactly the colours that were
 * sent to the model — not a separately-derived palette that could drift.
 */
export function brandPaletteFromRules(rules: Array<{ type: string; structured?: unknown }>): string[] {
  const hexes: string[] = [];
  for (const rule of rules) {
    if (rule.type !== "color") continue;
    const palette = (rule.structured as { palette?: unknown } | null | undefined)?.palette;
    if (!Array.isArray(palette)) continue;
    for (const entry of palette) {
      const hex = (entry as { hex?: unknown } | null | undefined)?.hex;
      if (typeof hex === "string" && parseHex(hex)) hexes.push(hex);
    }
  }
  return [...new Set(hexes)];
}
