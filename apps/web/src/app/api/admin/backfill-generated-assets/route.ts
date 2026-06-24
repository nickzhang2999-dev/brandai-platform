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
const BATCH = 200;
const MAX_SCAN = 5000; // 单次调用扫描上界，防 handler 跑飞（admin 维护端点）。

export async function POST() {
  try {
    await requireAdmin();
    // **游标分页扫描全部版本**（按 id 顺扫，非"仅未镜像"）。原实现固定取最旧 1000 条
    // 未镜像版本：mirrorGenerationVersionToAsset 永久跳过的行（内联 data: URL / 旧存储
    // 域 / 未配存储）会一直留在该窗口里，反复重扫同一批、永远到不了后面可镜像的版本
    // （Codex P2）。游标始终前移、越过跳过的行，故不再卡窗。已镜像的行廉价跳过。
    let cursor: string | undefined;
    let scanned = 0;
    let mirrored = 0;
    let skipped = 0;
    let alreadyMirrored = 0;
    while (scanned < MAX_SCAN) {
      const batch = await prisma.generationVersion.findMany({
        orderBy: { id: "asc" },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          mirrorAsset: { select: { id: true } },
          generation: {
            select: { workspaceId: true, scene: true, sceneType: true },
          },
        },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.id;
      scanned += batch.length;
      for (const gv of batch) {
        if (gv.mirrorAsset) {
          alreadyMirrored += 1; // 已回流（唯一约束保证至多一条）—— 幂等跳过。
          continue;
        }
        const did = await mirrorGenerationVersionToAsset({
          workspaceId: gv.generation.workspaceId,
          generationVersionId: gv.id,
          imageUrl: gv.imageUrl,
          width: gv.width,
          height: gv.height,
          sceneType: gv.generation.sceneType,
          fileLabel: `${(gv.generation.scene || "AI 出图").slice(0, 40)} #${gv.index + 1}`,
          aiDescription: gv.generation.scene || undefined,
        });
        if (did) mirrored += 1;
        else skipped += 1; // 未配存储 / URL 不在存储域 / 写失败 —— 已 warn，不致命。
      }
      if (batch.length < BATCH) break;
    }

    return ok({
      scanned,
      mirrored,
      skipped,
      alreadyMirrored,
      capped: scanned >= MAX_SCAN,
    });
  } catch (err) {
    return handleError(err);
  }
}
