import { prisma, Prisma } from "@brandai/db";
import { NativeProjectQueryInput, StudioWorkflowTarget, StudioWorkflowSaveInput, StudioWorkflowView } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { workflowAssets, workflowIssues, assertWorkflowSelection } from "./studio-workflow-codec";
import { inspectEditorDocument } from "./editor-document-codec";

type Db = Prisma.TransactionClient;
const projectQuery = NativeProjectQueryInput.pick({ projectId: true });
const conflict = () => new ApiException(409, "素材设置已被其他页面更新。当前选择仍保留，请读取最新设置后检查。");
const materialWhere = (workspaceId: string, projectId: string) => ({
  workspaceId, projectId, task: { status: "SUCCEEDED" as const },
  asset: { workspaceId, deprecatedAt: null, projectLinks: { some: { projectId, project: { workspaceId } } } },
});
const stateSelect = { workspaceId: true, workflowRevision: true, workflowMode: true,
  workflowTarget: true, workflowReferences: true, workflowUpdatedAt: true } satisfies Prisma.WorkbenchProjectStateSelect;
type WorkflowRow = Prisma.WorkbenchProjectStateGetPayload<{ select: typeof stateSelect }>;

function storedWorkflow(workspaceId: string, projectId: string, row: WorkflowRow | null) {
  if (row && row.workspaceId !== workspaceId) throw new ApiException(409, "素材设置归属异常，请联系管理员。");
  const parsed = StudioWorkflowView.safeParse({ projectId, revision: row?.workflowRevision ?? 0,
    mode: row?.workflowMode ?? "generate", target: row?.workflowTarget ?? null,
    references: row ? row.workflowReferences : [], updatedAt: row?.workflowUpdatedAt?.getTime() ?? null, issues: [] });
  if (!parsed.success) throw new ApiException(409, "已保存的素材设置格式异常，原内容未覆盖，请联系管理员。");
  return parsed.data;
}

async function projectExists(db: Db, workspaceId: string, projectId: string) {
  const project = await db.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
  if (!project) throw new ApiException(404, "项目不存在。");
}

async function assets(db: Db, workspaceId: string, projectId: string) {
  const doc = await db.editorDocument.findUnique({ where: { projectId }, select: { workspaceId: true, format: true, canvas: true } });
  if (doc && (doc.workspaceId !== workspaceId || doc.format !== "novart-native-v1")) {
    throw new ApiException(409, "画布归属或格式异常，请联系管理员。");
  }
  if (!doc?.canvas) return workflowAssets(projectId, "", []);
  const { urls } = inspectEditorDocument(doc.canvas);
  const prefix = `/api/workspaces/${workspaceId}/assets/`;
  const ids = urls.filter(url => url.startsWith(prefix) && url.endsWith("/raw"))
    .map(url => url.slice(prefix.length, -4)).filter(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id));
  const scope = materialWhere(workspaceId, projectId);
  // The document codec bounds distinct resource URLs. Filter by those exact
  // IDs/URLs rather than truncating a user's larger material library.
  const rows = urls.length ? await db.studioMaterialUpload.findMany({
    where: { ...scope, asset: { ...scope.asset, OR: [{ id: { in: ids } }, { url: { in: urls } }] } },
    select: { sha256: true, mimeType: true, asset: { select: { id: true, url: true } } },
    orderBy: [{ createdAt: "asc" }, { taskId: "asc" }],
  }) : [];
  const materials = rows.flatMap(row => {
    if (!row.asset || !/^[a-f0-9]{64}$/.test(row.sha256) || !["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)) return [];
    const raw = `/api/workspaces/${workspaceId}/assets/${row.asset.id}/raw`;
    // Both entries come from the same authenticated Asset row. No basename,
    // URL hash or client-supplied digest can establish ownership.
    return [...new Set([raw, row.asset.url].filter(Boolean))].map(url => ({ sha256: row.sha256, mimeType: row.mimeType, url }));
  });
  return workflowAssets(projectId, doc?.canvas ?? "", materials);
}

export async function readStudioWorkflowAssets(workspaceId: string, userId: string, raw: unknown) {
  const { projectId } = projectQuery.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  return prisma.$transaction(async tx => {
    await projectExists(tx, workspaceId, projectId);
    return assets(tx, workspaceId, projectId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10_000 });
}

export async function readStudioWorkflow(workspaceId: string, userId: string, raw: unknown) {
  const { projectId } = projectQuery.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  return prisma.$transaction(async tx => {
    await projectExists(tx, workspaceId, projectId);
    const [row, currentAssets] = await Promise.all([
      tx.workbenchProjectState.findUnique({ where: { projectId }, select: stateSelect }), assets(tx, workspaceId, projectId),
    ]);
    const current = storedWorkflow(workspaceId, projectId, row);
    return StudioWorkflowView.parse({ ...current, issues: [...currentAssets.issues, ...workflowIssues(current, currentAssets.assets)] });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10_000 });
}

export async function saveStudioWorkflow(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioWorkflowSaveInput.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  return prisma.$transaction(async tx => {
    // The same Project lock is used by document saves, archive and context
    // changes. Workflow has its own revision and never modifies brief/notes.
    const locked = await tx.$queryRaw<Array<{ archivedAt: Date | null; description: string | null }>>`
      SELECT "archivedAt", "description" FROM "Project"
      WHERE "id" = ${input.projectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (!locked[0]) throw new ApiException(404, "项目不存在。");
    if (locked[0].archivedAt) throw new ApiException(409, "项目已归档，请恢复后再修改素材设置。");
    const row = await tx.workbenchProjectState.findUnique({ where: { projectId: input.projectId }, select: stateSelect });
    const current = storedWorkflow(workspaceId, input.projectId, row);
    if (current.revision !== input.revision) throw conflict();
    const currentAssets = await assets(tx, workspaceId, input.projectId);
    if (!assertWorkflowSelection(input, current, currentAssets.assets)) {
      throw new ApiException(422, "新选择的图片不属于当前画布的已保存素材，请刷新素材列表后重新选择。");
    }
    const data = { workflowRevision: input.revision + 1, workflowMode: input.mode,
      workflowTarget: input.target as Prisma.InputJsonValue ?? Prisma.DbNull,
      workflowReferences: input.references as Prisma.InputJsonValue, workflowUpdatedAt: new Date() };
    const saved = await tx.workbenchProjectState.upsert({ where: { projectId: input.projectId },
      create: { projectId: input.projectId, workspaceId, brief: locked[0].description ?? "", ...data }, update: data, select: stateSelect });
    return StudioWorkflowView.parse({ ...storedWorkflow(workspaceId, input.projectId, saved),
      issues: [...currentAssets.issues, ...workflowIssues(input, currentAssets.assets)] });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
}

/** Return a same-origin proxy path, never the stored upstream URL. */
export async function studioWorkflowImage(workspaceId: string, userId: string, raw: unknown, sha256: string) {
  const { projectId } = projectQuery.parse(raw);
  StudioWorkflowTarget.shape.assetSha256.parse(sha256);
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  await projectExists(prisma, workspaceId, projectId);
  const row = await prisma.studioMaterialUpload.findFirst({ where: { ...materialWhere(workspaceId, projectId), sha256 },
    select: { asset: { select: { id: true } } }, orderBy: [{ createdAt: "asc" }, { taskId: "asc" }] });
  if (!row?.asset) throw new ApiException(404, "项目素材不存在或已不可用。");
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(row.asset.id)}/raw`;
}
