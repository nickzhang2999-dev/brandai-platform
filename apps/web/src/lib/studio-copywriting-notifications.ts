import { prisma } from "@brandai/db";
import type { NotificationItem } from "@brandai/contracts";
export async function listCopywritingNotifications(workspaceId: string, userId: string, limit: number): Promise<NotificationItem[]> {
  const rows = await prisma.asyncTask.findMany({ where: { workspaceId, kind: "STUDIO_COPYWRITING", inputJson: { path: ["userId"], equals: userId }, status: { in: ["SUCCEEDED", "FAILED"] } },
    select: { id: true, kind: true, refId: true, status: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: limit });
  const eligible = rows.filter(row => row.kind === "STUDIO_COPYWRITING" && row.refId);
  if (!eligible.length) return [];
  const projects = await prisma.project.findMany({ where: { workspaceId, id: { in: eligible.map(row => row.refId!) } }, select: { id: true } });
  return eligible.filter(row => projects.some(project => project.id === row.refId)).map(row => ({ id: `copywriting:${row.id}`, kind: "STUDIO_COPYWRITING", status: row.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
    title: row.status === "SUCCEEDED" ? "文案已生成" : "文案生成未完成", detail: "打开项目画布，点击文案查看记录。",
    href: `/canvas?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(row.refId!)}`, createdAt: row.updatedAt.toISOString() }));
}
