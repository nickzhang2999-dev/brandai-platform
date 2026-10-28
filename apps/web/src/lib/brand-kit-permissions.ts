import { prisma } from "@brandai/db";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";

/** Recheck new Brand Kit receipts before paid work and before storing results.
 * Older imports have no recorded actor, so their existing behavior is preserved.
 * This helper never loads an asset URL, changes a receipt, or retries a task. */
export async function requireBrandKitTaskPermission(
  taskId: string | undefined,
  workspaceId: string,
  assetIds: string[],
): Promise<void> {
  if (typeof taskId !== "string" || !taskId.startsWith("bkit_")) return;

  const task = await prisma.asyncTask.findFirst({
    where: { id: taskId, workspaceId, kind: { in: ["RECOGNIZE", "PARSE_MANUAL"] } },
    select: { kind: true, inputJson: true },
  });
  const input = task?.inputJson;
  const userId = input && typeof input === "object" && !Array.isArray(input)
    && typeof input.userId === "string" ? input.userId : null;
  if (!task || !userId) throw new ApiException(403, "品牌解析任务的发起人或品牌范围已失效，已停止处理。");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!user?.isActive) throw new ApiException(403, "品牌解析任务的发起账号已不可用，已停止处理。");
  try {
    await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  } catch (error) {
    if (error instanceof ApiException && (error.status === 403 || error.status === 404)) {
      throw new ApiException(403, "品牌解析任务的编辑权限已失效，已停止处理。");
    }
    throw error;
  }

  const ids = [...new Set(assetIds)];
  if (!ids.length || ids.length > 50 || ids.some(id => !id)
    || (task.kind === "PARSE_MANUAL" && ids.length !== 1)) {
    throw new ApiException(409, "品牌解析任务的素材范围无效，已停止处理。");
  }
  const assets = await prisma.asset.findMany({
    where: {
      workspaceId,
      id: { in: ids },
      deprecatedAt: null,
      availableForGeneration: true,
      ...(task.kind === "PARSE_MANUAL" ? { category: "VI_DOC" as const } : {}),
    },
    select: { id: true },
  });
  if (assets.length !== ids.length) {
    throw new ApiException(409, "原素材已被移除、停用或不再属于当前品牌，已停止处理。");
  }
}
