import { prisma } from "@brandai/db";
import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";

/**
 * E13 · 素材使用记录 — derive REAL usage from generation data (no fabrication).
 *
 * The only durable Asset→generation linkage in 一期 is the reference-asset id
 * list persisted on each root `GenerationVersion.params.referenceAssetIds`
 * (written by the generate worker / regenerate route). We scan this workspace's
 * generations + versions, find every version whose params reference this asset,
 * and return the owning generation's Campaign + scene + first-use timestamp.
 *
 * If nothing references the asset, the list is empty — the client renders an
 * honest "暂无使用记录" empty state rather than inventing usages.
 */
type UsageRecord = {
  generationId: string;
  projectId: string;
  projectName: string;
  scene: string;
  sceneType: string;
  usedAt: string;
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; assetId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, assetId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    // Confirm the asset belongs to this workspace (avoids leaking usage for a
    // foreign asset id; §3.5 isolation rule 1).
    const asset = await prisma.asset.findFirst({
      where: { id: assetId, workspaceId: wsId },
      select: { id: true },
    });
    if (!asset) throw new ApiException(404, "Asset not found");

    // Pull this workspace's generations with their versions' params + the owning
    // Campaign name. Bounded scan: generations are workspace-scoped and indexed
    // by [workspaceId, createdAt]; we only read the params json we need.
    const generations = await prisma.generation.findMany({
      where: { workspaceId: wsId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        scene: true,
        sceneType: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
        versions: { select: { params: true, createdAt: true } },
      },
    });

    const records: UsageRecord[] = [];
    for (const g of generations) {
      // A generation "uses" this asset when any of its versions referenced it.
      const usingVersions = g.versions.filter((v) => {
        const p = (v.params ?? {}) as { referenceAssetIds?: unknown };
        return (
          Array.isArray(p.referenceAssetIds) &&
          p.referenceAssetIds.includes(assetId)
        );
      });
      const first = usingVersions[0];
      if (!first) continue;
      // Earliest referencing version is when this asset was first used here.
      const usedAt = usingVersions.reduce(
        (min, v) => (v.createdAt < min ? v.createdAt : min),
        first.createdAt,
      );
      records.push({
        generationId: g.id,
        projectId: g.project.id,
        projectName: g.project.name,
        scene: g.scene,
        sceneType: g.sceneType,
        usedAt: usedAt.toISOString(),
      });
    }

    return ok(records);
  } catch (err) {
    return handleError(err);
  }
}
