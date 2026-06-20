import { z } from "zod";
import { prisma } from "@brandai/db";
import { CampaignStatus } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { serializeProject } from "@/lib/generations";

/**
 * Single-Campaign endpoint. GET reads one project; PATCH drives the
 * Campaign lifecycle actions (C9 / L7) + AI-summary edits (H10 / H11),
 * always workspace-scoped (no cross-workspace read/write).
 *
 * Campaign lifecycle: the shared `CampaignStatus` enum is
 * `DRAFT | IN_PROGRESS | COMPLETED` (see contracts enums.ts). There is NO
 * dedicated REVIEW status, so the actions map honestly onto existing values:
 *   - 「提交终审」(submit for final review) → IN_PROGRESS  (closest existing
 *     "under review / in progress" state; no invented enum member).
 *   - 「归档项目」(archive / done)          → COMPLETED.
 * A real REVIEW state would require adding it to the shared enum (a contract
 * change owned elsewhere) before it could be wired here.
 *
 * The update input is a small, local, frozen-additive zod schema — contracts
 * (api.ts) are owned by another agent, so no contract edit. Only `status` and
 * `aiSummary` are mutable here; both columns already exist on the Project model.
 */
const PatchProjectInput = z
  .object({
    status: CampaignStatus.optional(),
    aiSummary: z.string().max(4000).optional(),
  })
  .refine((v) => v.status !== undefined || v.aiSummary !== undefined, {
    message: "Nothing to update",
  });

async function loadScoped(wsId: string, projectId: string) {
  const existing = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!existing || existing.workspaceId !== wsId) {
    throw new ApiException(404, "Project not found");
  }
  return existing;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const project = await loadScoped(wsId, projectId);
    return ok(serializeProject(project));
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    // EDITOR+ to mutate status / summary — matches the POST/PATCH rank on the
    // list route (projects/route.ts uses "EDITOR").
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(PatchProjectInput, await req.json());
    await loadScoped(wsId, projectId);

    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.aiSummary != null ? { aiSummary: input.aiSummary } : {}),
      },
    });
    return ok(serializeProject(project));
  } catch (err) {
    return handleError(err);
  }
}
