import { prisma } from "@brandai/db";
import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { mirrorGenerationVersionToAsset } from "@/lib/asset-mirror";

/**
 * F18 · 出图回流素材库 · 一次性回填 — admin-only。把本次特性上线**之前**已产出的
 * 出图版本（真实 provider → 真实 API → 真实 DB 的历史产物）补建镜像 Asset，使旧出图
 * 也出现在素材库。**非伪造**：镜像 url 指向同一张真实生成图。`generationVersionId`
 * 唯一约束 + 跳过已镜像的版本 → 幂等，可安全重复调用。
 *
 * 走 admin 通道而非 worker：历史版本已落库，回填只是补投影；由超管显式触发可控。
 */
export async function POST() {
  try {
    await requireAdmin();
    // 只取还没镜像的出图版本（含其 generation 的 scene/sceneType 供分类/命名）。
    const orphans = await prisma.generationVersion.findMany({
      where: { mirrorAsset: { is: null } },
      include: {
        generation: {
          select: { workspaceId: true, scene: true, sceneType: true },
        },
      },
      orderBy: { createdAt: "asc" },
      take: 1000,
    });

    let mirrored = 0;
    let skipped = 0;
    for (const gv of orphans) {
      const before = await prisma.asset.count({
        where: { generationVersionId: gv.id },
      });
      await mirrorGenerationVersionToAsset({
        workspaceId: gv.generation.workspaceId,
        generationVersionId: gv.id,
        imageUrl: gv.imageUrl,
        width: gv.width,
        height: gv.height,
        sceneType: gv.generation.sceneType,
        fileLabel: `${(gv.generation.scene || "AI 出图").slice(0, 40)} #${gv.index + 1}`,
        aiDescription: gv.generation.scene || undefined,
      });
      const after = await prisma.asset.count({
        where: { generationVersionId: gv.id },
      });
      if (after > before) mirrored += 1;
      else skipped += 1; // 未配存储 / URL 不在存储域 / 写失败 —— 已 warn，不致命。
    }

    return ok({ scanned: orphans.length, mirrored, skipped });
  } catch (err) {
    return handleError(err);
  }
}
