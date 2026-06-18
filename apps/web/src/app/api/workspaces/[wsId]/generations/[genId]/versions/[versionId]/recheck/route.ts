import { prisma } from "@brandai/db";
import { ComplianceReport } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { runComplianceCheck } from "@/lib/compliance";
import { setVersionComplianceReport } from "@/lib/generations";

/**
 * M5 · 生成后复检 (post-generation recheck).
 *
 * POST /api/workspaces/[wsId]/generations/[genId]/versions/[versionId]/recheck
 *
 * Re-runs compliance on a finalized GenerationVersion: text recheck on the
 * owning generation's selling point + scene AND a visual check on the
 * version's image (imageUrl is passed to the AI compliance check, which
 * returns `visualResults` from the VLM mock — Logo 存在 / 主色 / 禁用元素 /
 * 产品变形). The resulting `ComplianceReport` is persisted into
 * `GenerationVersion.complianceReport` (Json) and returned.
 */
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

    const text = [generation.sellingPoint, generation.scene]
      .filter(Boolean)
      .join("。");

    const { report } = await runComplianceCheck({
      workspaceId: wsId,
      text,
      imageUrl: version.imageUrl,
    });

    const saved = await setVersionComplianceReport(
      versionId,
      ComplianceReport.parse(report),
    );
    return ok(saved);
  } catch (err) {
    return handleError(err);
  }
}
