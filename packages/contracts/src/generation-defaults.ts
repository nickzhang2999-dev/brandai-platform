export const GENERATION_SELLING_POINT_MAX_LENGTH = 500;
export const GENERATION_SCENE_MAX_LENGTH = 160;

export type GenerationDefaultSource = "user" | "system";

export type GenerationDefaultProject = {
  name?: string | null;
  campaign?: string | null;
  product?: string | null;
  channel?: string | null;
  channels?: string[] | null;
  description?: string | null;
  aiSummary?: string | null;
};

export type GenerationDefaultBrand = {
  name?: string | null;
  industry?: string | null;
};

export type ResolveGenerationDefaultsInput = {
  project?: GenerationDefaultProject | null;
  brand?: GenerationDefaultBrand | null;
  sceneType?: string | null;
  sellingPoint?: string | null;
  scene?: string | null;
};

export type ResolvedGenerationDefaults = {
  sellingPoint: string;
  scene: string;
  sellingPointSource: GenerationDefaultSource;
  sceneSource: GenerationDefaultSource;
};

const SCENE_TYPE_LABELS: Record<string, string> = {
  ECOM_MAIN: "电商主图",
  SCENE: "场景图",
  SOCIAL_POSTER: "社交海报",
  CAMPAIGN_KV: "Campaign KV",
  SELLING_POINT: "卖点图",
};

function clean(value?: string | null): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function truncate(value: string, max: number): string {
  const trimmed = clean(value);
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function firstText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function channelText(project?: GenerationDefaultProject | null): string {
  const channels = [
    clean(project?.channel),
    ...(project?.channels ?? []).map((channel) => clean(channel)),
  ].filter(Boolean);
  return Array.from(new Set(channels)).join("、");
}

export function getSceneTypeLabel(sceneType?: string | null): string {
  const key = clean(sceneType);
  return SCENE_TYPE_LABELS[key] ?? (key || "视觉物料");
}

export function resolveGenerationDefaults(
  input: ResolveGenerationDefaultsInput,
): ResolvedGenerationDefaults {
  const userSellingPoint = truncate(
    input.sellingPoint ?? "",
    GENERATION_SELLING_POINT_MAX_LENGTH,
  );
  const userScene = truncate(input.scene ?? "", GENERATION_SCENE_MAX_LENGTH);
  const sceneTypeLabel = getSceneTypeLabel(input.sceneType);
  const brandName = firstText(input.brand?.name);
  const industry = firstText(input.brand?.industry);
  const projectName = firstText(input.project?.name);
  const campaign = firstText(input.project?.campaign);
  const product = firstText(input.project?.product);
  const channel = channelText(input.project);
  const subject = firstText(product, campaign, projectName, "核心产品/活动");
  const owner = firstText(brandName, projectName, "品牌");

  const systemSellingPoint = firstText(
    input.project?.aiSummary,
    input.project?.description,
    `为「${owner}」生成${sceneTypeLabel}，围绕${subject}，突出${
      industry ? `${industry}行业` : "品牌"
    }调性、清晰卖点与可商用的视觉质感。`,
  );
  const systemScene = channel
    ? `适合${channel}投放的${firstText(campaign, projectName, subject)}${sceneTypeLabel}场景`
    : `突出${firstText(campaign, projectName, subject)}主题的${sceneTypeLabel}场景`;

  return {
    sellingPoint:
      userSellingPoint ||
      truncate(systemSellingPoint, GENERATION_SELLING_POINT_MAX_LENGTH),
    scene: userScene || truncate(systemScene, GENERATION_SCENE_MAX_LENGTH),
    sellingPointSource: userSellingPoint ? "user" : "system",
    sceneSource: userScene ? "user" : "system",
  };
}
