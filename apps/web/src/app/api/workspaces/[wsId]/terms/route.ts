import { prisma } from "@brandai/db";
import { CreateComplianceTermInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const terms = await prisma.complianceTerm.findMany({
      where: { workspaceId: wsId },
      orderBy: { createdAt: "desc" },
    });
    return ok(terms);
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
    const input = parse(CreateComplianceTermInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    const term = await prisma.complianceTerm.create({
      data: {
        workspaceId: wsId,
        type: input.type,
        term: input.term,
        reason: input.reason,
        replacement: input.replacement,
      },
    });
    return ok(term, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
