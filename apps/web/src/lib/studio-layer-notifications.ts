import { prisma } from "@brandai/db";
import type { NotificationItem } from "@brandai/contracts";

const statuses = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"] as const;
type Status = typeof statuses[number];
type ScopedRequest = { id: string; workspaceId: string; userId: string; projectId: string; status: string };

/** These rows retain soft project IDs for eventual cleanup. Never create a
 * cross-brand or deleted-project link from the request alone. Routes enforce
 * membership; the projection additionally keeps events private to the actor. */
async function visibleRequests<T extends ScopedRequest>(workspaceId: string, userId: string, rows: T[]): Promise<T[]> {
  const own = rows.filter(row => row.workspaceId === workspaceId && row.userId === userId);
  if (!own.length) return [];
  const projects = await prisma.project.findMany({
    where: { workspaceId, id: { in: [...new Set(own.map(row => row.projectId))] } },
    select: { id: true, workspaceId: true },
  });
  const visible = new Set(projects.filter(project => project.workspaceId === workspaceId).map(project => project.id));
  return own.filter(row => visible.has(row.projectId));
}

export async function listStudioLayerNotifications(workspaceId: string, userId: string, limit: number): Promise<NotificationItem[]> {
  const bounded = Number.isFinite(limit) ? Math.max(0, Math.min(50, Math.floor(limit))) : 30;
  if (!bounded) return [];
  const rows = await prisma.studioDecompositionRequest.findMany({
    where: { workspaceId, userId, status: { in: ["SUCCEEDED", "FAILED"] } },
    select: { id: true, workspaceId: true, userId: true, projectId: true, status: true, updatedAt: true },
    orderBy: { updatedAt: "desc" }, take: bounded,
  });
  return (await visibleRequests(workspaceId, userId, rows))
    .filter(row => row.status === "SUCCEEDED" || row.status === "FAILED")
    .map((row): NotificationItem => {
      const succeeded = row.status === "SUCCEEDED";
      return {
        id: `studio-decomposition:${row.id}`, kind: "STUDIO_DECOMPOSITION",
        status: succeeded ? "SUCCEEDED" : "FAILED",
        title: succeeded ? "AI 图层已保存" : "AI 分层未完成",
        detail: succeeded ? "可返回对应画布，在分层面板查看并加入图层。" : "请返回对应画布查看任务状态和可用操作。已有模型结果可重新保存，请勿重复提交分层。",
        href: `/canvas?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(row.projectId)}&layerRequestId=${encodeURIComponent(row.id)}`,
        createdAt: row.updatedAt.toISOString(),
      };
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, bounded);
}

export type StudioLayerActivity = { requests: Array<{
  id: string; requestId: string; projectId: string; status: Status;
  createdAt: string; expiresAt: string; layerCount: number;
}> };

/** A small, read-only task projection. Do not expire tasks or load provider
 * results on polling: the worker owns processing and deadline transitions. */
export async function listStudioLayerActivity(workspaceId: string, userId: string): Promise<StudioLayerActivity> {
  const rows = await prisma.studioDecompositionRequest.findMany({
    where: { workspaceId, userId, status: { in: [...statuses] } },
    select: { id: true, workspaceId: true, userId: true, projectId: true, status: true, createdAt: true, expiresAt: true, layerCount: true },
    orderBy: { createdAt: "desc" }, take: 50,
  });
  const own = await visibleRequests(workspaceId, userId, rows);
  return { requests: own.filter(row => statuses.includes(row.status as Status)).slice(0, 50).map(row => ({
    id: row.id, requestId: row.id, projectId: row.projectId, status: row.status as Status,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), layerCount: row.layerCount,
  })) };
}
