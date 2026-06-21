import { prisma } from "@brandai/db";
import { CreateAssetFolderInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";

/**
 * E3 · 素材文件夹（AssetFolder）— workspace 作用域的素材分组。
 *
 * GET  → list folders (with assetCount) for the workspace.
 * POST → create a folder. Both are workspace-scoped + member-checked (§3.5
 *        isolation rule 1); no cross-workspace read/write.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const folders = await prisma.assetFolder.findMany({
      where: { workspaceId: wsId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { assets: true } } },
    });
    return ok(
      folders.map((f) => ({
        id: f.id,
        workspaceId: f.workspaceId,
        name: f.name,
        createdAt: f.createdAt.toISOString(),
        assetCount: f._count.assets,
      })),
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(CreateAssetFolderInput, await req.json());
    const folder = await prisma.assetFolder.create({
      data: { workspaceId: wsId, name: input.name.trim() },
    });
    return ok(
      {
        id: folder.id,
        workspaceId: folder.workspaceId,
        name: folder.name,
        createdAt: folder.createdAt.toISOString(),
        assetCount: 0,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleError(err);
  }
}
