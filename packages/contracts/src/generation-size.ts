import type {
  GenerationAspectRatioKey,
  GenerationResolutionTier,
  GenerationSizeSelection,
  SizeSpec,
} from "./ai";

export type GenerationImageQuality = "medium" | "high";

export interface GenerationAspectRatioPreset {
  key: Exclude<GenerationAspectRatioKey, "custom">;
  label: string;
  usage: string;
  sizes: Record<GenerationResolutionTier, { width: number; height: number }>;
}

/**
 * V0.0.20 — the 12 supported product ratios. 2K always doubles both 1K edges,
 * producing four times the pixels instead of merely changing a display label.
 */
export const GENERATION_ASPECT_RATIO_PRESETS: readonly GenerationAspectRatioPreset[] =
  [
    {
      key: "1:1",
      label: "方形",
      usage: "电商主图 / 朋友圈",
      sizes: {
        "1K": { width: 1024, height: 1024 },
        "2K": { width: 2048, height: 2048 },
      },
    },
    {
      key: "4:5",
      label: "竖版",
      usage: "小红书 / Instagram",
      sizes: {
        "1K": { width: 1024, height: 1280 },
        "2K": { width: 2048, height: 2560 },
      },
    },
    {
      key: "3:4",
      label: "竖版",
      usage: "小红书封面 / 海报",
      sizes: {
        "1K": { width: 960, height: 1280 },
        "2K": { width: 1920, height: 2560 },
      },
    },
    {
      key: "2:3",
      label: "竖版",
      usage: "海报 / 电商长图",
      sizes: {
        "1K": { width: 1024, height: 1536 },
        "2K": { width: 2048, height: 3072 },
      },
    },
    {
      key: "9:16",
      label: "全屏竖版",
      usage: "小红书视频 / 抖音",
      sizes: {
        "1K": { width: 720, height: 1280 },
        "2K": { width: 1440, height: 2560 },
      },
    },
    {
      key: "5:4",
      label: "横版",
      usage: "内容配图 / 展示图",
      sizes: {
        "1K": { width: 1280, height: 1024 },
        "2K": { width: 2560, height: 2048 },
      },
    },
    {
      key: "4:3",
      label: "横版",
      usage: "公众号 / 演示配图",
      sizes: {
        "1K": { width: 1280, height: 960 },
        "2K": { width: 2560, height: 1920 },
      },
    },
    {
      key: "3:2",
      label: "横版",
      usage: "摄影 / 公众号头图",
      sizes: {
        "1K": { width: 1536, height: 1024 },
        "2K": { width: 3072, height: 2048 },
      },
    },
    {
      key: "16:10",
      label: "宽屏",
      usage: "演示文稿 / 桌面展示",
      sizes: {
        "1K": { width: 1280, height: 800 },
        "2K": { width: 2560, height: 1600 },
      },
    },
    {
      key: "16:9",
      label: "视频横版",
      usage: "KV / 视频封面",
      sizes: {
        "1K": { width: 1280, height: 720 },
        "2K": { width: 2560, height: 1440 },
      },
    },
    {
      key: "2.35:1",
      label: "电影宽幅",
      usage: "超宽 KV / Banner",
      sizes: {
        "1K": { width: 1504, height: 640 },
        "2K": { width: 3008, height: 1280 },
      },
    },
    {
      key: "3:1",
      label: "超宽",
      usage: "站内 Banner / 户外屏",
      sizes: {
        "1K": { width: 1536, height: 512 },
        "2K": { width: 3072, height: 1024 },
      },
    },
  ] as const;

export const DEFAULT_GENERATION_SIZE_SELECTION: GenerationSizeSelection = {
  ratioKey: "1:1",
  resolutionTier: "1K",
};

const GPT_IMAGE_2_MIN_PIXELS = 655_360;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_2_MAX_EDGE = 3_840;
const CUSTOM_1K_TARGET_PIXELS = 1_048_576;
// A 2K custom image doubles both edges. Bounding the 1K search here guarantees
// the doubled result still fits gpt-image-2's edge and total-pixel limits.
const CUSTOM_1K_MAX_EDGE = GPT_IMAGE_2_MAX_EDGE / 2;
const CUSTOM_1K_MAX_PIXELS = GPT_IMAGE_2_MAX_PIXELS / 4;

export function generationQualityForTier(
  tier: GenerationResolutionTier,
): GenerationImageQuality {
  return tier === "2K" ? "high" : "medium";
}

export function validateGptImage2Size(
  width: number,
  height: number,
): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return "宽高必须为整数";
  }
  if (
    width <= 0 ||
    height <= 0 ||
    width > GPT_IMAGE_2_MAX_EDGE ||
    height > GPT_IMAGE_2_MAX_EDGE
  ) {
    return `宽高必须在 1 到 ${GPT_IMAGE_2_MAX_EDGE} 像素之间`;
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    return "宽高必须是 16 的倍数";
  }
  const pixels = width * height;
  if (pixels < GPT_IMAGE_2_MIN_PIXELS || pixels > GPT_IMAGE_2_MAX_PIXELS) {
    return `总像素需在 ${GPT_IMAGE_2_MIN_PIXELS} 到 ${GPT_IMAGE_2_MAX_PIXELS} 之间`;
  }
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > 3) return "长边与短边之比不能超过 3:1";
  return null;
}

function resolveCustom1K(
  requestedWidth: number,
  requestedHeight: number,
): { width: number; height: number } {
  const requestedRatio = requestedWidth / requestedHeight;
  let best:
    | { width: number; height: number; ratioError: number; areaError: number }
    | undefined;

  for (let width = 16; width <= CUSTOM_1K_MAX_EDGE; width += 16) {
    for (let height = 16; height <= CUSTOM_1K_MAX_EDGE; height += 16) {
      const pixels = width * height;
      if (pixels < GPT_IMAGE_2_MIN_PIXELS || pixels > CUSTOM_1K_MAX_PIXELS) {
        continue;
      }
      const ratio = width / height;
      if (ratio < 1 / 3 || ratio > 3) continue;
      const ratioError = Math.abs(Math.log(ratio / requestedRatio));
      const areaError =
        Math.abs(pixels - CUSTOM_1K_TARGET_PIXELS) / CUSTOM_1K_TARGET_PIXELS;
      if (
        !best ||
        ratioError < best.ratioError - Number.EPSILON ||
        (Math.abs(ratioError - best.ratioError) <= Number.EPSILON &&
          areaError < best.areaError)
      ) {
        best = { width, height, ratioError, areaError };
      }
    }
  }

  if (!best) {
    throw new Error("无法在 gpt-image-2 的尺寸范围内解析该自定义比例");
  }
  return { width: best.width, height: best.height };
}

export function resolveGenerationSize(
  selection: GenerationSizeSelection,
): SizeSpec {
  if (selection.ratioKey !== "custom") {
    const preset = GENERATION_ASPECT_RATIO_PRESETS.find(
      (item) => item.key === selection.ratioKey,
    );
    if (!preset) throw new Error(`未知比例：${selection.ratioKey}`);
    const size = preset.sizes[selection.resolutionTier];
    const validationError = validateGptImage2Size(size.width, size.height);
    if (validationError) {
      throw new Error(
        `预设 ${selection.ratioKey} ${selection.resolutionTier} 无效：${validationError}`,
      );
    }
    return {
      key: `chat-${selection.resolutionTier.toLowerCase()}-${selection.ratioKey.replace(":", "x")}`,
      label: `${selection.resolutionTier} · ${selection.ratioKey}`,
      width: size.width,
      height: size.height,
      ratioKey: selection.ratioKey,
      resolutionTier: selection.resolutionTier,
      requestedRatio: selection.ratioKey,
    };
  }

  if (!selection.customRatio) {
    throw new Error("自定义比例需要填写宽和高");
  }
  const requestedRatio =
    selection.customRatio.width / selection.customRatio.height;
  if (requestedRatio < 1 / 3 || requestedRatio > 3) {
    throw new Error("自定义比例需在 1:3 到 3:1 之间");
  }
  const base = resolveCustom1K(
    selection.customRatio.width,
    selection.customRatio.height,
  );
  const multiplier = selection.resolutionTier === "2K" ? 2 : 1;
  const size = {
    width: base.width * multiplier,
    height: base.height * multiplier,
  };
  const validationError = validateGptImage2Size(size.width, size.height);
  if (validationError) {
    throw new Error(`自定义尺寸无效：${validationError}`);
  }
  const requestedRatioLabel = `${selection.customRatio.width}:${selection.customRatio.height}`;
  return {
    key: `chat-${selection.resolutionTier.toLowerCase()}-custom-${size.width}x${size.height}`,
    label: `${selection.resolutionTier} · 自定义 ${requestedRatioLabel}`,
    width: size.width,
    height: size.height,
    ratioKey: "custom",
    resolutionTier: selection.resolutionTier,
    requestedRatio: requestedRatioLabel,
  };
}
