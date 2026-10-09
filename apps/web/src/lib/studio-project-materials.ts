import type { Prisma } from "@brandai/db";

/** SHA identifies bytes, never ownership. Both sources require real project links. */
export async function listStudioProjectMaterials(db: Prisma.TransactionClient, workspaceId: string, projectId: string, urls?: string[], sha256?: string) {
  if (urls?.length === 0) return [];
  const prefix = `/api/workspaces/${workspaceId}/assets/`;
  const ids = urls?.filter(url => url.startsWith(prefix) && url.endsWith("/raw"))
    .map(url => url.slice(prefix.length, -4)).filter(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id)) ?? [];
  const asset = { workspaceId, deprecatedAt: null, availableForGeneration: true,
    projectLinks: { some: { projectId, project: { workspaceId } } },
    ...(urls ? { OR: [{ id: { in: ids } }, { url: { in: urls } }] } : {}) };
  const [uploads, generated] = await Promise.all([
    db.studioMaterialUpload.findMany({ where: { workspaceId, projectId, task: { status: "SUCCEEDED" }, asset, ...(sha256 ? { sha256 } : {}) },
      select: { sha256: true, mimeType: true, width: true, height: true, asset: { select: { id: true, url: true } } }, orderBy: [{ createdAt: "asc" }, { taskId: "asc" }] }),
    db.studioGeneratedMaterial.findMany({ where: { workspaceId, projectId, status: "SUCCEEDED", asset, ...(sha256 ? { sha256 } : {}),
      request: { workspaceId, projectId }, output: { workspaceId, projectId }, version: { generation: { workspaceId, projectId } } },
      select: { sha256: true, mimeType: true, width: true, height: true, versionId: true, asset: { select: { id: true, url: true, generationVersionId: true } } }, orderBy: [{ createdAt: "asc" }, { outputId: "asc" }] }),
  ]);
  return [...uploads, ...generated.filter(row => row.versionId && row.asset?.generationVersionId === row.versionId)].flatMap(row => {
    if (!row.asset || !row.sha256 || !/^[a-f0-9]{64}$/.test(row.sha256) || !row.mimeType || !["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)) return [];
    const raw = `${prefix}${row.asset.id}/raw`;
    return [...new Set([raw, row.asset.url].filter(Boolean))].map(url => ({ assetId: row.asset!.id, sha256: row.sha256!, mimeType: row.mimeType!, width: row.width, height: row.height, url }));
  });
}
