import { z } from "zod";
import { prisma } from "@brandai/db";
import { CampaignStatus, CreateProjectInput } from "@brandai/contracts";
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
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const url = new URL(req.url);
    const includeLatestCover = url.searchParams.get("latestCover") === "1";
    return ok(
      await listWorkspaceProjects(wsId, {
        includeLatestCover,
        ...(includeLatestCover ? { take: 8 } : {}),
      }),
    );
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

    const body = await req.json();
    const input = parse(CreateProjectInput, { ...body, workspaceId: wsId });
    const extra = parse(BrandaiProjectFields, body);
    const project = await prisma.project.create({
      data: {
        workspaceId: wsId,
        name: input.name,
        campaign: input.campaign,
        product: input.product,
        channel: input.channel,
        ...(extra.status ? { status: extra.status } : {}),
        ...(extra.progress != null ? { progress: extra.progress } : {}),
        ...(extra.description != null
          ? { description: extra.description }
          : {}),
        ...(extra.tags ? { tags: extra.tags } : {}),
        ...(extra.channels ? { channels: extra.channels } : {}),
        ...(extra.aiSummary != null ? { aiSummary: extra.aiSummary } : {}),
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
// BrandAI Campaign 业务字段（与 CreateProjectInput 的基础字段并存，全部可选；
// DB 列已存在，见 packages/db schema 的 Project 模型）。
const BrandaiProjectFields = z.object({
  status: CampaignStatus.optional(),
  progress: z.number().int().min(0).max(100).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string()).max(20).optional(),
  channels: z.array(z.string()).max(20).optional(),
  aiSummary: z.string().max(4000).optional(),
});

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

    const body = await req.json();
    const input = parse(UpdateProjectInput, body);
    const extra = parse(BrandaiProjectFields, body);
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
        ...(extra.status ? { status: extra.status } : {}),
        ...(extra.progress != null ? { progress: extra.progress } : {}),
        ...(extra.description != null
          ? { description: extra.description }
          : {}),
        ...(extra.tags ? { tags: extra.tags } : {}),
        ...(extra.channels ? { channels: extra.channels } : {}),
        ...(extra.aiSummary != null ? { aiSummary: extra.aiSummary } : {}),
      },
    });
    return ok(serializeProject(project));
  } catch (err) {
    return handleError(err);
  }
}
