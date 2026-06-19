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
    // 职责分离:只有 待审(PENDING)/ 已驳回(REJECTED) 的版本可(重新)提交。
    // 否则 editor 直接 submit 一个已 APPROVED / 终稿版本会清空审核结论并退回
    // SUBMITTED,等于绕过 review 端点的职责分离、撤销审核者决定。
    if (
      version.isFinal ||
      (version.reviewStatus !== "PENDING" &&
        version.reviewStatus !== "REJECTED")
    ) {
      throw new ApiException(
        409,
        "仅待审或已驳回的版本可提交;已批准或终稿不可回退",
      );
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
