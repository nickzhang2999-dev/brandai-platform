import { prisma } from "@brandai/db";
import { StudioBrandRuleStatus } from "../../../../packages/contracts/src/studio-brand-rule-status";
import { requireWorkspaceRole } from "./workspace";
import { ApiException } from "./api";

/** Metadata only; never confirms/imports a rule or submits recognition. */
export async function readStudioBrandRuleStatus(workspaceId: string, userId: string) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const workspace = await prisma.brandWorkspace.findUnique({ where: { id: workspaceId },
    select: { id: true, name: true, tags: true,
      rules: { where: { status: { in: ["CONFIRMED", "DRAFT"] } }, select: { status: true } },
      workbenchBrand: { select: { revision: true } },
    } });
  if (!workspace) throw new ApiException(404, "品牌不存在或已移除。");
  return StudioBrandRuleStatus.parse({ workspaceId: workspace.id, brandName: workspace.name,
    applicationEnabled: !workspace.tags.includes("__kb_disabled"),
    confirmedCount: workspace.rules.filter(rule => rule.status === "CONFIRMED").length,
    draftCount: workspace.rules.filter(rule => rule.status === "DRAFT").length,
    savedDraftAvailable: !!workspace.workbenchBrand,
  });
}
