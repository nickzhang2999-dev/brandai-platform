import { prisma } from "@brandai/db";
import {
  ApiException,
  handleError,
  ok,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { createComplianceTask } from "@/lib/compliance-tasks";

/** Legacy version recheck is durable and async; Studio keeps its existing single-claim flow. */
export async function POST(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ wsId: string; genId: string; versionId: string }>;
  },
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
    // Product versions use a durable, single-claim check and private-S3 byte
    // transport. The legacy task route must not bypass that boundary.
    const studio = await prisma.studioGenerationRequest.findUnique({ where: { generationId: genId }, select: { id: true } });
    if (studio) throw new ApiException(409, "请在工作台使用“重试检查”，产品图片的视觉检查需要异步执行。");

    const text = [generation.sellingPoint, generation.scene]
      .filter(Boolean)
      .join("。");

    const accepted = await createComplianceTask(wsId, "COMPLIANCE_RECHECK", {
      userId: user.id, projectId: generation.projectId, generationId: genId,
      versionId, imageUrl: version.imageUrl, text,
    });
    return ok(accepted, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}
