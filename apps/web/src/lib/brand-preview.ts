import { prisma } from "@brandai/db";
import type { BrandRule } from "@brandai/contracts";

/**
 * D10 — brand preview (composite visual auto-generation).
 *
 * Composes a generation brief from the workspace's CONFIRMED brand knowledge
 * (color system / typography / tone / visual references / design rules) so the
 * existing server-authoritative generate pipeline can render a single
 * representative "brand preview" image. This module only BUILDS the brief +
 * resolves the dedicated preview Project; the route reuses the normal generate
 * enqueue (quota reservation + BullMQ `generate` job) so there is no second AI
 * code path. §2 holds: nothing here calls the AI service.
 */

/** The hidden project that holds brand-preview generations for a workspace. */
export const BRAND_PREVIEW_PROJECT_NAME = "品牌预览";

/**
 * Resolve (or create) the dedicated "品牌预览" Project for a workspace. Brand
 * previews need a Project to attach to (Generation.projectId is required); we
 * keep them in one stable project per workspace instead of polluting the user's
 * Campaign list with a new project per preview.
 */
export async function getOrCreatePreviewProject(
  workspaceId: string,
): Promise<{ id: string }> {
  const existing = await prisma.project.findFirst({
    where: { workspaceId, name: BRAND_PREVIEW_PROJECT_NAME },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  return prisma.project.create({
    data: {
      workspaceId,
      name: BRAND_PREVIEW_PROJECT_NAME,
      description: "由品牌套件自动合成的品牌视觉预览（D10）。",
      status: "DRAFT",
    },
    select: { id: true },
  });
}

type Val = Record<string, unknown>;
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Distil the confirmed rule library into a short, human-readable selling-point
 * brief for the preview generation. The generate worker ALSO loads the full
 * confirmed rule library into AIConstraints, so this brief is the creative
 * direction layered on top of the hard brand constraints — not a duplication of
 * them. Returns `null` when there's nothing confirmed yet (the caller turns
 * that into a clear "先确认品牌知识" error instead of generating noise).
 */
export function composeBrandBrief(
  brandName: string,
  rules: BrandRule[],
): string | null {
  if (rules.length === 0) return null;

  const parts: string[] = [];
  const byType = (t: string) => rules.filter((r) => r.type === t);

  // Color
  const colorHints: string[] = [];
  for (const r of byType("color")) {
    const v = (r.value ?? {}) as Val;
    const palette = [
      ...asArr(v.palette),
      ...asArr(v.colors),
    ]
      .map((c) =>
        typeof c === "string"
          ? c
          : asStr((c as Val)?.hex) ?? asStr((c as Val)?.color),
      )
      .filter((s): s is string => !!s);
    if (palette.length) colorHints.push(...palette.slice(0, 5));
    else if (r.summary) colorHints.push(r.summary);
  }
  if (colorHints.length)
    parts.push(`品牌主色：${[...new Set(colorHints)].slice(0, 5).join("、")}`);

  // Typography
  const fontHints = byType("font")
    .map((r) => r.summary)
    .filter(Boolean);
  if (fontHints.length) parts.push(`字体调性：${fontHints[0]}`);

  // Tone of voice / copy
  const toneHints = byType("copy")
    .map((r) => r.summary)
    .filter(Boolean);
  if (toneHints.length) parts.push(`品牌指南：${toneHints[0]}`);

  // Visual references / imagery + layout + graphic — fold their summaries.
  const visualHints = [
    ...byType("imagery"),
    ...byType("layout"),
    ...byType("graphic"),
    ...byType("logo"),
  ]
    .map((r) => r.summary)
    .filter(Boolean)
    .slice(0, 3);
  if (visualHints.length) parts.push(`视觉风格：${visualHints.join("；")}`);

  const brief =
    `为「${brandName}」生成一张能代表品牌整体视觉调性的品牌预览主视觉，` +
    `综合体现以下品牌知识：${parts.join("；")}。` +
    `构图精致、统一，作为品牌形象展示卡使用。`;

  // selling-point field caps at sane length; keep it well within limits.
  return brief.slice(0, 500);
}
