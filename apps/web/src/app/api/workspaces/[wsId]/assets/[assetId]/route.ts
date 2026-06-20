import { z } from "zod";
import { prisma } from "@brandai/db";
import { AssetCategory } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";

/**
 * Asset PATCH — supports category edits plus P1.3 lifecycle fields:
 * - `availableForGeneration`: toggle whether the asset feeds M3 generation
 * - `deprecatedAt`: ISO timestamp (or `null` to revive)
 * - `replacementAssetId`: optional pointer to a successor asset
 */
const UpdateAssetInput = z.object({
  category: AssetCategory.optional(),
  availableForGeneration: z.boolean().optional(),
  deprecatedAt: z.string().datetime().nullable().optional(),
  replacementAssetId: z.string().nullable().optional(),
});

async function loadAsset(wsId: string, assetId: string, userId: string) {
  await requireWorkspaceRole(wsId, userId, "EDITOR");
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.workspaceId !== wsId) {
    throw new ApiException(404, "Asset not found");
  }
  return asset;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; assetId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, assetId } = await params;
    await loadAsset(wsId, assetId, user.id);
    const input = parse(UpdateAssetInput, await req.json());
    const data: Record<string, unknown> = {};
    if (input.category !== undefined) data.category = input.category;
    if (input.availableForGeneration !== undefined)
      data.availableForGeneration = input.availableForGeneration;
    if (input.deprecatedAt !== undefined)
      data.deprecatedAt = input.deprecatedAt ? new Date(input.deprecatedAt) : null;
    if (input.replacementAssetId !== undefined)
      data.replacementAssetId = input.replacementAssetId;
    const asset = await prisma.asset.update({
      where: { id: assetId },
      data,
    });
    return ok(asset);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; assetId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, assetId } = await params;
    await loadAsset(wsId, assetId, user.id);
    await prisma.asset.delete({ where: { id: assetId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
