import { z } from "zod";
import { prisma } from "@brandai/db";
import { CreateProjectInput } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import {
  listWorkspaceProjects,
  serializeProject,
} from "@/lib/generations";

/**
 * Projects group Generations under a brand/campaign/product/channel. The
 * generation wizard (M3) picks or inline-creates one before generating;
 * M6 owns deeper project management.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    return ok(await listWorkspaceProjects(wsId));
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

    const input = parse(CreateProjectInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: wsId,
        name: input.name,
        campaign: input.campaign,
        product: input.product,
        channel: input.channel,
      },
    });
    return ok(serializeProject(project), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * PATCH → edit a project's name / campaign / product / channel. The
 * frozen `CreateProjectInput` is the create contract; edits reuse the
 * same field shape via a local schema (no contract change). Reads/writes
 * stay workspace-scoped.
 */
const UpdateProjectInput = z.object({
  id: z.string(),
  name: z.string().min(1),
  campaign: z.string().optional(),
  product: z.string().optional(),
  channel: z.string().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(UpdateProjectInput, await req.json());
    const existing = await prisma.project.findUnique({
      where: { id: input.id },
    });
    if (!existing || existing.workspaceId !== wsId) {
      throw new ApiException(404, "Project not found");
    }
    const project = await prisma.project.update({
      where: { id: input.id },
      data: {
        name: input.name,
        campaign: input.campaign ?? null,
        product: input.product ?? null,
        channel: input.channel ?? null,
      },
    });
    return ok(serializeProject(project));
  } catch (err) {
    return handleError(err);
  }
}
