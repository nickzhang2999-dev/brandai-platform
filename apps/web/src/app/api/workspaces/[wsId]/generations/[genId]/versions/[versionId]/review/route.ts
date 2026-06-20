import { prisma } from "@brandai/db";
import { ReviewDecisionInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { getWorkspaceRole } from "@/lib/workspace";
import { getGeneration } from "@/lib/generations";

/**
 * G6 · POST → approve/reject a submitted version. Approval is a separation-of-
 * duties action: ONLY the OWNER or a REVIEWER may approve/reject — an EDITOR
 * (who creates/submits content) cannot approve, even though it outranks
 * REVIEWER for content writes. Records the reviewer, time and optional note.
 * An APPROVED version may then be marked final (see the generation PATCH gate).
 */
export async function POST(
  req: Request,
  {
    params,
  }: { params: Promise<{ wsId: string; genId: string; versionId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, versionId } = await params;
    const role = await getWorkspaceRole(wsId, user.id);
    if (!role) throw new ApiException(404, "Workspace not found");
    if (role !== "OWNER" && role !== "REVIEWER") {
      throw new ApiException(403, "仅所有者或审核角色可审批");
    }

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
    // 职责分离:仅可审批"已提交"的版本。否则审核者能把 editor 从未提交的
    // PENDING 草稿直接 APPROVED,而终选端点对非 owner 只认 APPROVED,等于让
    // 未提交草稿被标为终稿,绕过提交环节。
    if (version.reviewStatus !== "SUBMITTED") {
      throw new ApiException(409, "仅可审批已提交(SUBMITTED)的版本");
    }
    const input = parse(ReviewDecisionInput, await req.json());
    await prisma.generationVersion.update({
      where: { id: versionId },
      data: {
        reviewStatus: input.decision,
        reviewedById: user.id,
        reviewedAt: new Date(),
        reviewNote: input.note ?? null,
      },
    });
    return ok(await getGeneration(genId));
  } catch (err) {
    return handleError(err);
  }
}
