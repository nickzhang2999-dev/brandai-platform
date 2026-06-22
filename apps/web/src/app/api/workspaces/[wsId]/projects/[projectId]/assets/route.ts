import { prisma } from "@brandai/db";
import {
  LinkProjectAssetInput,
  ProjectAssetKind,
  type ProjectAssetLink,
} from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { serializeAsset } from "@/lib/assets";

/**
 * E11/E12 · Project↔Asset 关联 — 「加入项目」(MEMBER) 与「设为参考」(REFERENCE)
 * 的服务端真关系（取代 reference-tray 客户端暂存，跨设备/协作可续）。
 *
 * GET    ?kind=REFERENCE|MEMBER → list linked assets (optionally filtered).
 * POST   { assetId, kind }      → upsert a link.
 * DELETE { assetId, kind }      → remove a link.
 *
 * 全程 workspace 作用域 + 成员校验（§3.5 隔离规则 1）；project 与 asset 都必须属于
 * 本 workspace（IDOR 防护，§3.5 隔离规则 2）。
 */

async function loadScopedProject(wsId: string, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.workspaceId !== wsId) {
    throw new ApiException(404, "Project not found");
  }
  return project;
}

type LinkRow = {
  id: string;
  projectId: string;
  kind: string;
  createdAt: Date;
  asset: Parameters<typeof serializeAsset>[0];
};

function serializeLink(row: LinkRow): ProjectAssetLink {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: ProjectAssetKind.parse(row.kind),
    createdAt: row.createdAt.toISOString(),
    asset: serializeAsset(row.asset),
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    await loadScopedProject(wsId, projectId);

    const kindRaw = new URL(req.url).searchParams.get("kind");
    const kind = kindRaw ? ProjectAssetKind.safeParse(kindRaw) : null;
    if (kindRaw && (!kind || !kind.success)) {
      throw new ApiException(400, "Invalid kind");
    }

    const rows = await prisma.projectAsset.findMany({
      where: {
        projectId,
        ...(kind && kind.success ? { kind: kind.data } : {}),
      },
      include: { asset: true },
      orderBy: { createdAt: "desc" },
    });
    return ok(rows.map(serializeLink));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    await loadScopedProject(wsId, projectId);

    const input = parse(LinkProjectAssetInput, await req.json());

    // IDOR guard: the asset must belong to the same workspace.
    const asset = await prisma.asset.findUnique({
      where: { id: input.assetId },
      select: { workspaceId: true },
    });
    if (!asset || asset.workspaceId !== wsId) {
      throw new ApiException(404, "Asset not found");
    }

    // Idempotent: unique (projectId, assetId, kind) — re-linking is a no-op
    // that returns the existing row.
    const existing = await prisma.projectAsset.findFirst({
      where: { projectId, assetId: input.assetId, kind: input.kind },
      include: { asset: true },
    });
    const row =
      existing ??
      (await prisma.projectAsset.create({
        data: { projectId, assetId: input.assetId, kind: input.kind },
        include: { asset: true },
      }));
    return ok(serializeLink(row), { status: existing ? 200 : 201 });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    await loadScopedProject(wsId, projectId);

    const input = parse(LinkProjectAssetInput, await req.json());
    await prisma.projectAsset.deleteMany({
      where: { projectId, assetId: input.assetId, kind: input.kind },
    });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
