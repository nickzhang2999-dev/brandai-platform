import { prisma } from "@brandai/db";
import type { NotificationItem } from "@brandai/contracts";
import { projectStudioGenerationResults, studioArtifactViewSelect } from "./studio-generation-result-view";

/** Membership is checked by the route; product events also belong to a user. */
export async function listStudioGenerationNotifications(workspaceId: string, userId: string, limit: number): Promise<NotificationItem[]> {
  const now = new Date();
  // Archive completion can be much later than provider completion. Take recent
  // archive events independently, so newer requests do not hide an older result.
  const [archiveEvents, expiredAttempts, strandedOutputs, archivedRequests, failedRequests] = await Promise.all([
    prisma.studioGeneratedMaterial.findMany({ where: { workspaceId, userId,
      request: { workspaceId, userId, status: "SUCCEEDED" },
      status: { in: ["SUCCEEDED", "FAILED"] },
    }, select: { requestId: true }, orderBy: { updatedAt: "desc" }, take: limit }),
    prisma.studioGeneratedMaterial.findMany({ where: { workspaceId, userId,
      request: { workspaceId, userId, status: "SUCCEEDED" },
      status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: now },
    }, select: { requestId: true }, orderBy: { expiresAt: "desc" }, take: limit }),
    prisma.studioGenerationOutput.findMany({ where: { workspaceId, artifact: { is: null },
      request: { workspaceId, userId, status: "SUCCEEDED" },
      expiresAt: { lte: now },
    }, select: { requestId: true }, orderBy: { expiresAt: "desc" }, take: limit }),
    prisma.studioGenerationRequest.findMany({ where: { workspaceId, userId, status: "SUCCEEDED",
      generation: { workspaceId, project: { workspaceId, archivedAt: { not: null } } },
      outputs: { some: { artifact: { is: null } } },
    }, select: { id: true }, orderBy: { generation: { project: { archivedAt: "desc" } } }, take: limit }),
    prisma.studioGenerationRequest.findMany({ where: { workspaceId, userId, status: "FAILED" },
      select: { id: true }, orderBy: { updatedAt: "desc" }, take: limit }),
  ]);
  const ids = [...new Set([...archiveEvents, ...expiredAttempts, ...strandedOutputs].map(row => row.requestId).concat([...archivedRequests, ...failedRequests].map(row => row.id)))];
  if (!ids.length) return [];
  const rows = await prisma.studioGenerationRequest.findMany({ where: {
    id: { in: ids }, workspaceId, userId, status: { in: ["SUCCEEDED", "FAILED"] },
    generation: { workspaceId, project: { workspaceId } },
  }, select: { id: true, workspaceId: true, userId: true, projectId: true, generationId: true, status: true, updatedAt: true,
    generation: { select: { projectId: true, project: { select: { id: true, workspaceId: true, archivedAt: true } } } },
    outputs: { select: { id: true, expiresAt: true } },
    artifacts: { where: { workspaceId, userId }, select: studioArtifactViewSelect },
  } });
  return rows.flatMap((row): NotificationItem[] => {
    const project = row.generation.project;
    if (row.workspaceId !== workspaceId || row.userId !== userId || row.projectId !== project.id || row.generation.projectId !== project.id || project.workspaceId !== workspaceId) return [];
    const href = `/canvas?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(row.projectId)}&requestId=${encodeURIComponent(row.id)}`;
    const common = { id: `studio-generation:${row.id}`, kind: "STUDIO_GENERATION" as const, href };
    if (row.status === "FAILED") return [{ ...common, status: "FAILED", title: "图片生成未完成",
      detail: "请返回画布查看任务原因；确认原任务状态后再发起新的生成。", createdAt: row.updatedAt.toISOString() }];
    const view = projectStudioGenerationResults(row, { outputs: row.outputs, artifacts: row.artifacts, project }, now.getTime());
    if (view.resultState !== "READY" && view.resultState !== "FAILED") return [];
    const finished = Math.max(row.updatedAt.getTime(), project.archivedAt?.getTime() ?? 0,
      ...row.outputs.filter(output => output.expiresAt <= now && !row.artifacts.some(artifact => artifact.outputId === output.id && artifact.status === "SUCCEEDED")).map(output => output.expiresAt.getTime()),
      ...row.artifacts.map(artifact =>
      ["PENDING", "RUNNING"].includes(artifact.status) && artifact.expiresAt <= now ? artifact.expiresAt.getTime() : artifact.updatedAt.getTime()));
    return [{ ...common, status: view.resultState === "READY" ? "SUCCEEDED" : "FAILED",
      title: view.resultState === "READY" ? "生成图片已保存" : "生成图片保存未完成",
      detail: view.resultState === "READY" ? "可返回画布查看或加入图片。" : "请返回画布查看原因和可用操作；不要重复提交图片生成。",
      createdAt: new Date(finished).toISOString() }];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
