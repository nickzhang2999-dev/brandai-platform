import { prisma } from "@brandai/db";
import { CreateComplianceTermInput } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";

/**
 * PUT → M5 词库编辑: full update of a ComplianceTerm (type / term / reason /
 * replacement). Reuses the frozen `CreateComplianceTermInput` shape (it
 * already carries every editable field + workspaceId) so no contract
 * change is needed.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ wsId: string; termId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, termId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const existing = await prisma.complianceTerm.findUnique({
      where: { id: termId },
    });
    if (!existing || existing.workspaceId !== wsId) {
      throw new ApiException(404, "Term not found");
    }
    const input = parse(CreateComplianceTermInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    const term = await prisma.complianceTerm.update({
      where: { id: termId },
      data: {
        type: input.type,
        term: input.term,
        reason: input.reason,
        replacement: input.replacement ?? null,
      },
    });
    return ok(term);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; termId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, termId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const term = await prisma.complianceTerm.findUnique({
      where: { id: termId },
    });
    if (!term || term.workspaceId !== wsId) {
      throw new ApiException(404, "Term not found");
    }
    await prisma.complianceTerm.delete({ where: { id: termId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
