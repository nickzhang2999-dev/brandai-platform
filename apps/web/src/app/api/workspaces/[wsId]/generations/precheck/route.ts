import { prisma } from "@brandai/db";
import {
  CreateGenerationInput,
  resolveGenerationDefaults,
} from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { createComplianceTask } from "@/lib/compliance-tasks";

/** Accept a durable generation brief check; no model call in this handler. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(CreateGenerationInput, await req.json());

    // Ownership of the target project must hold for the workspace.
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
    });
    if (!project || project.workspaceId !== wsId) {
      throw new ApiException(404, "Project not found in this workspace");
    }
    const workspace = await prisma.brandWorkspace.findUnique({
      where: { id: wsId },
      select: { name: true, industry: true },
    });
    const resolvedBrief = resolveGenerationDefaults({
      project,
      brand: workspace,
      sceneType: input.sceneType,
      sellingPoint: input.sellingPoint,
      scene: input.scene,
    });

    const result = await createComplianceTask(wsId, "GENERATION_PRECHECK", {
      userId: user.id, projectId: project.id, text: resolvedBrief.sellingPoint,
    });
    return ok(result, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}
