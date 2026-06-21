import { z } from "zod";
import { prisma } from "@brandai/db";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";

/**
 * E3 · 单个素材文件夹 — rename (PATCH) / delete (DELETE).
 * Deleting a folder un-files its assets (Asset.folderId → null via SetNull FK),
 * never deletes the assets. Workspace-scoped + ownership-checked (no IDOR).
 */
const UpdateFolderInput = z.object({ name: z.string().min(1).max(60) });

async function loadFolder(wsId: string, folderId: string, userId: string) {
  await requireWorkspaceRole(wsId, userId, "EDITOR");
  const folder = await prisma.assetFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.workspaceId !== wsId) {
    throw new ApiException(404, "Folder not found");
  }
  return folder;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; folderId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, folderId } = await params;
    await loadFolder(wsId, folderId, user.id);
    const input = parse(UpdateFolderInput, await req.json());
    const folder = await prisma.assetFolder.update({
      where: { id: folderId },
      data: { name: input.name.trim() },
    });
    return ok({
      id: folder.id,
      workspaceId: folder.workspaceId,
      name: folder.name,
      createdAt: folder.createdAt.toISOString(),
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; folderId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, folderId } = await params;
    await loadFolder(wsId, folderId, user.id);
    // SetNull FK un-files the assets automatically; just delete the folder row.
    await prisma.assetFolder.delete({ where: { id: folderId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
