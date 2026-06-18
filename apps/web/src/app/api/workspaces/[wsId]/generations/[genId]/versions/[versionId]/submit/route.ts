import { prisma } from "@brandai/db";
import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { getGeneration } from "@/lib/generations";

/**
 * G6 · POST → submit a generation version for review (EDITOR+). Moves it to
 * SUBMITTED so a reviewer can approve/reject. Clears any prior verdict.
 */
export async function POST(
  _req: Request,
  {
    params,
  }: { params: Promise<{ wsId: string; genId: string; versionId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, versionId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const generation = await prisma.generation.findUnique({
      where: { id: genId },
    });
    if (!generation || generation.workspaceId !== wsId) {
      throw new ApiException(404, "Generation not found");
    }
    const version = await prisma.generationVersion.findUnique({
      where: { id: versionId },
    });
    if (!version || version.generationId !== genId) {
      throw new ApiException(404, "Version not found in this generation");
    }
    await prisma.generationVersion.update({
      where: { id: versionId },
      data: {
        reviewStatus: "SUBMITTED",
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });
    return ok(await getGeneration(genId));
  } catch (err) {
    return handleError(err);
  }
}
