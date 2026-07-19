import { prisma, Prisma } from "@brandai/db";
import { CanvasStateSchema, UpsertCanvasInputSchema } from "@brandai/contracts";
import { ApiException, handleError, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { getProject } from "@/lib/generations";

/**
 * V0.0.13d · 工作台画布服务端持久化（对齐 prd_agent image_master_canvases）。
 * GET  = 恢复画布（items + camera + removedVersionIds）；无记录返回空态。
 * PUT  = 整份状态 upsert（last-writer-wins；只存引用与布局，data:/blob: 被契约拒绝）。
 * 纯 DB 读写、无慢调用（§2 天然满足）；workspace 归属 + project IDOR 双守卫。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireWorkspaceRole(wsId, user.id, "VIEWER");
    const project = await getProject(wsId, projectId);
    if (!project) throw new ApiException(404, "Project not found");

    const row = await prisma.projectCanvas.findUnique({
      where: { projectId },
    });
    if (!row || row.workspaceId !== wsId) {
      return Response.json({ items: [], removedVersionIds: [] });
    }
    // 出参也过契约：DB 里的历史脏数据（若有）被归一而不是原样外泄。
    const state = CanvasStateSchema.safeParse({
      items: row.items,
      camera: row.camera ?? undefined,
      removedVersionIds: row.removedVersionIds,
    });
    return Response.json(
      state.success ? state.data : { items: [], removedVersionIds: [] },
    );
  } catch (e) {
    return handleError(e);
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const project = await getProject(wsId, projectId);
    if (!project) throw new ApiException(404, "Project not found");

    const body = parse(UpsertCanvasInputSchema, await req.json());
    const data = {
      workspaceId: wsId,
      items: body.items as object[],
      camera: body.camera ?? Prisma.JsonNull,
      removedVersionIds: body.removedVersionIds,
    };
    await prisma.projectCanvas.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
