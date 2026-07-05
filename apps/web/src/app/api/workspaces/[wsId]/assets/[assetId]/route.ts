import { z } from "zod";
import { prisma } from "@brandai/db";
import { AssetCategory } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { serializeAsset } from "@/lib/assets";

/**
 * Asset PATCH — supports category edits plus P1.3 lifecycle fields:
 * - `availableForGeneration`: toggle whether the asset feeds M3 generation
 * - `deprecatedAt`: ISO timestamp (or `null` to revive)
 * - `replacementAssetId`: optional pointer to a successor asset
 */
const UpdateAssetInput = z.object({
  category: AssetCategory.optional(),
  tags: z.array(z.string().min(1).max(32)).max(50).optional(),
  availableForGeneration: z.boolean().optional(),
  deprecatedAt: z.string().datetime().nullable().optional(),
  replacementAssetId: z.string().nullable().optional(),
  // E13 — favorite toggle (star). `Asset.isFavorite` already exists in schema.
  isFavorite: z.boolean().optional(),
  // E3 — move into a folder (id) or un-file (null). Folder ownership is
  // validated below (must belong to the same workspace) to prevent IDOR.
  folderId: z.string().nullable().optional(),
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
    if (input.tags !== undefined)
      data.tags = Array.from(new Set(input.tags.map((t) => t.trim()).filter(Boolean)));
    if (input.availableForGeneration !== undefined)
      data.availableForGeneration = input.availableForGeneration;
    if (input.isFavorite !== undefined) data.isFavorite = input.isFavorite;
    if (input.deprecatedAt !== undefined)
      data.deprecatedAt = input.deprecatedAt ? new Date(input.deprecatedAt) : null;
    if (input.replacementAssetId !== undefined)
      data.replacementAssetId = input.replacementAssetId;
    if (input.folderId !== undefined) {
      // §3.5 isolation rule 2 — a cross-workspace folder reference is an IDOR;
      // verify the target folder belongs to this workspace before filing.
      if (input.folderId !== null) {
        const folder = await prisma.assetFolder.findUnique({
          where: { id: input.folderId },
          select: { workspaceId: true },
        });
        if (!folder || folder.workspaceId !== wsId) {
          throw new ApiException(404, "Folder not found");
        }
      }
      data.folderId = input.folderId;
    }
    const asset = await prisma.asset.update({
      where: { id: assetId },
      data,
    });
    return ok(serializeAsset(asset));
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
