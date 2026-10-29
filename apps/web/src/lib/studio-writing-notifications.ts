import { prisma } from "@brandai/db";
import type { NotificationItem } from "@brandai/contracts";

export async function listWritingNotifications(workspaceId: string, userId: string, limit: number): Promise<NotificationItem[]> {
  if (!workspaceId || !userId) return [];
  limit = Math.max(1, Math.min(100, Math.trunc(limit) || 30));
  const rows = await prisma.asyncTask.findMany({ where: { workspaceId, kind: "STUDIO_WRITING", inputJson: { path: ["userId"], equals: userId }, status: { in: ["SUCCEEDED", "FAILED"] } },
    select: { id: true, refId: true, status: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: limit });
  if (!rows.length) return [];
  const projects = await prisma.project.findMany({ where: { workspaceId, id: { in: rows.flatMap(row => row.refId ? [row.refId] : []) } }, select: { id: true } });
  return rows.filter(row => row.refId && projects.some(p => p.id === row.refId)).map(row => ({ id: `writing:${row.id}`, kind: "STUDIO_WRITING",
    status: row.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", title: row.status === "SUCCEEDED" ? "文案工作台任务已完成" : "文案工作台任务未完成",
    detail: "返回独立文案工作台查看资料、风格草稿或生成建议。", href: `/studio-writing?${new URLSearchParams({ workspaceId, projectId: row.refId!, taskId: row.id })}`, createdAt: row.updatedAt.toISOString() }));
}
