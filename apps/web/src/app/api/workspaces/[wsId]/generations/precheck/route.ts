import { prisma } from "@brandai/db";
import { CreateGenerationInput } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { runPrecheck } from "@/lib/precheck";

/**
 * Pre-generation compliance precheck (M3 → M5 adapter front-door).
 *
 * The wizard calls this before it submits the generation so RISK / FORBIDDEN
 * findings can be surfaced and the user can revise the copy. The actual
 * resolution lives in `lib/precheck.ts` (which prefers an M5-owned
 * `/compliance/precheck` route and falls back to the AI service). Keeping the
 * precheck behind this stable route + adapter means M5 can take over without
 * touching the wizard.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    const input = parse(CreateGenerationInput, await req.json());

    // Ownership of the target project must hold for the workspace.
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
    });
    if (!project || project.workspaceId !== wsId) {
      throw new ApiException(404, "Project not found in this workspace");
    }

    const origin = new URL(req.url).origin;
    const result = await runPrecheck({
      workspaceId: wsId,
      text: input.sellingPoint,
      baseUrl: origin,
    });
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
