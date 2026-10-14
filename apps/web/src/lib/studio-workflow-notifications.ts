import { prisma } from "@brandai/db";
import type { NotificationItem } from "@brandai/contracts";

/** Private metadata projections. Never read prompts, reference payloads,
 * masks or raw provider errors merely to build a cross-page notification. */
export async function listStudioWorkflowNotifications(workspaceId: string, userId: string, limit: number): Promise<NotificationItem[]> {
  const bounded = Number.isFinite(limit) ? Math.max(0, Math.min(50, Math.floor(limit))) : 30;
  if (!bounded) return [];
  const [messages, materials] = await Promise.all([
    prisma.studioConversationMessage.findMany({ where: { conversation: { workspaceId, userId }, generationRequestId: null, status: { in: ["CLARIFICATION", "FAILED"] } },
      select: { id: true, status: true, updatedAt: true, conversation: { select: { workspaceId: true, userId: true, projectId: true } } }, orderBy: { updatedAt: "desc" }, take: bounded }),
    prisma.studioBrandMaterialReceipt.findMany({ where: { workspaceId, userId, asset: { workspaceId }, task: { workspaceId, kind: "STUDIO_MATERIAL_VERIFY", status: { in: ["SUCCEEDED", "FAILED"] } } },
      select: { assetId: true, workspaceId: true, userId: true, updatedAt: true, asset: { select: { workspaceId: true, deprecatedAt: true } }, task: { select: { status: true, updatedAt: true } } }, orderBy: { updatedAt: "desc" }, take: bounded }),
  ]);
  const ownMessages = messages.filter(row => row.conversation.workspaceId === workspaceId && row.conversation.userId === userId && ["CLARIFICATION", "FAILED"].includes(row.status));
  const projects = ownMessages.length ? await prisma.project.findMany({ where: { workspaceId, id: { in: [...new Set(ownMessages.map(row => row.conversation.projectId))] } }, select: { id: true, workspaceId: true } }) : [];
  const visibleProjects = new Set(projects.filter(row => row.workspaceId === workspaceId).map(row => row.id));
  const items: NotificationItem[] = ownMessages.filter(row => visibleProjects.has(row.conversation.projectId)).map(row => ({
    id: `studio-conversation:${row.id}`, kind: "STUDIO_CONVERSATION", status: row.status === "FAILED" ? "FAILED" : "SUCCEEDED",
    title: row.status === "CLARIFICATION" ? "设计需求需要确认" : "设计对话未完成",
    detail: row.status === "CLARIFICATION" ? "请返回项目对话明确图片目标或尺寸，尚未调用生图模型。" : "请返回项目读取原任务和失败原因，不要重复发送未确认请求。",
    href: `/studio?workspaceId=${encodeURIComponent(workspaceId)}#/workspace/${encodeURIComponent(row.conversation.projectId)}`, createdAt: row.updatedAt.toISOString(),
  }));
  for (const row of materials) {
    if (row.workspaceId !== workspaceId || row.userId !== userId || row.asset.workspaceId !== workspaceId || row.asset.deprecatedAt || !["SUCCEEDED", "FAILED"].includes(row.task.status)) continue;
    const success = row.task.status === "SUCCEEDED";
    items.push({ id: `studio-material-verify:${row.assetId}`, kind: "STUDIO_MATERIAL_VERIFY", status: success ? "SUCCEEDED" : "FAILED",
      title: success ? "品牌素材已确认" : "品牌素材校验未完成", detail: success ? "可在品牌素材库中选择使用。" : "原素材仍保留，请在素材库读取校验原因。",
      href: `/studio?workspaceId=${encodeURIComponent(workspaceId)}#/resources`, createdAt: row.task.updatedAt.toISOString() });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, bounded);
}
