import { prisma } from "@brandai/db";
import { BatchUpdateAssetTagsInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { serializeAsset } from "@/lib/assets";

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)),
  ).slice(0, 50);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(BatchUpdateAssetTagsInput, await req.json());
    const assetIds = Array.from(new Set(input.assetIds));
    const tags = normalizeTags(input.tags);

    const assets: { id: string; tags: string[] }[] = await prisma.asset.findMany({
      where: { id: { in: assetIds }, workspaceId: wsId },
      select: { id: true, tags: true },
    });
    if (assets.length !== assetIds.length) {
      const found = new Set(assets.map((a) => a.id));
      const missing = assetIds.filter((id) => !found.has(id));
      throw new ApiException(
        404,
        `部分素材不存在或不属于当前品牌：${missing.join(", ")}`,
      );
    }

    const updated = await prisma.$transaction(
      assets.map((asset) => {
        const current = asset.tags ?? [];
        const next =
          input.mode === "replace"
            ? tags
            : input.mode === "remove"
              ? current.filter((t) => !tags.includes(t))
              : normalizeTags([...current, ...tags]);
        return prisma.asset.update({
          where: { id: asset.id },
          data: { tags: next },
        });
      }),
    );

    return ok(updated.map(serializeAsset));
  } catch (err) {
    return handleError(err);
  }
}
