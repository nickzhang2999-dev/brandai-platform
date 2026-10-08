import { prisma, Prisma } from "@brandai/db";
import { EditorDocumentSaveInput, EditorDocumentView } from "@brandai/contracts";
import { requireWorkspaceRole } from "./workspace";
import { EditorDocumentError, inspectEditorDocument, assertDocumentReferences, documentWriteDecision } from "./editor-document-codec";

function view(projectId: string, workspaceId: string, readOnly: boolean, row: {
  format: string; canvas: string; revision: number; checksum: string; updatedAt: Date;
} | null): EditorDocumentView {
  if (row && row.format !== "novart-native-v1") throw new EditorDocumentError(409, "UNSUPPORTED_DOCUMENT", "该画布由更新版本保存，请升级编辑器后打开。");
  return EditorDocumentView.parse({ projectId, workspaceId, readOnly, format: "novart-native-v1",
    canvas: row?.canvas ?? "", revision: row?.revision ?? 0,
    checksum: row?.checksum ?? null, updatedAt: row?.updatedAt.toISOString() ?? null });
}

export async function readEditorDocument(workspaceId: string, projectId: string, userId: string) {
  const { role } = await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, include: { editorDocument: true } });
  if (!project) throw new EditorDocumentError(404, "PROJECT_NOT_FOUND", "项目不存在。");
  const row = project.editorDocument;
  if (row && row.workspaceId !== workspaceId) throw new EditorDocumentError(409, "INVALID_DOCUMENT_OWNER", "画布归属异常，请联系管理员。");
  return view(projectId, workspaceId, !!project.archivedAt || !["OWNER", "EDITOR"].includes(role), row);
}

export async function saveEditorDocument(workspaceId: string, projectId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = EditorDocumentSaveInput.parse(raw);
  const inspected = inspectEditorDocument(input.canvas);
  return prisma.$transaction(async tx => {
    // Lock the Project row: concurrent first saves and archive changes must serialize.
    const rows = await tx.$queryRaw<Array<{ id: string; archivedAt: Date | null }>>`
      SELECT "id", "archivedAt" FROM "Project"
      WHERE "id" = ${projectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (!rows[0]) throw new EditorDocumentError(404, "PROJECT_NOT_FOUND", "项目不存在。");
    if (rows[0].archivedAt) throw new EditorDocumentError(409, "PROJECT_ARCHIVED", "项目已归档，请恢复后再编辑。");
    const current = await tx.editorDocument.findUnique({ where: { projectId } });
    if (current && (current.workspaceId !== workspaceId || current.format !== input.format)) {
      throw new EditorDocumentError(409, "UNSUPPORTED_DOCUMENT", "画布格式或归属异常，未覆盖已有内容。");
    }
    const decision = documentWriteDecision(current, input, inspected.checksum, userId);
    if (decision === "replay") return view(projectId, workspaceId, false, current);
    // Every embedded image must resolve to this workspace's stored asset, or
    // a generation in this project. Never authorize by URL basename/hash alone.
    const assetPrefix = `/api/workspaces/${workspaceId}/assets/`;
    const versionPrefix = `/api/workspaces/${workspaceId}/generations/`;
    const assetIds = inspected.urls.filter(url => url.startsWith(assetPrefix) && url.endsWith("/raw"))
      .map(url => url.slice(assetPrefix.length, -4)).filter(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id));
    const versionIds = inspected.urls.filter(url => url.startsWith(versionPrefix))
      .map(url => url.slice(versionPrefix.length).match(/^[a-zA-Z0-9_-]+\/versions\/([a-zA-Z0-9_-]+)\/download$/)?.[1])
      .filter((id): id is string => !!id);
    const assets = await tx.asset.findMany({
      where: { workspaceId, deprecatedAt: null, mimeType: { startsWith: "image/" },
        OR: [{ id: { in: assetIds } }, { url: { in: inspected.urls } }] },
      select: { id: true, url: true },
    });
    const versions = await tx.generationVersion.findMany({
      where: { generation: { workspaceId, projectId },
        OR: [{ id: { in: versionIds } }, { imageUrl: { in: inspected.urls } }] },
      select: { id: true, generationId: true, imageUrl: true },
    });
    const allowed = new Set<string>();
    for (const a of assets) {
      if (a.url) allowed.add(a.url);
      allowed.add(`/api/workspaces/${workspaceId}/assets/${a.id}/raw`);
    }
    for (const v of versions) {
      if (v.imageUrl) allowed.add(v.imageUrl);
      allowed.add(`/api/workspaces/${workspaceId}/generations/${v.generationId}/versions/${v.id}/download`);
    }
    assertDocumentReferences(inspected.urls, allowed);
    const data = { canvas: input.canvas, checksum: inspected.checksum, mutationId: input.mutationId, updatedById: userId, revision: input.revision + 1 };
    const saved = await tx.editorDocument.upsert({ where: { projectId },
      create: { projectId, workspaceId, format: input.format, ...data }, update: data });
    return view(projectId, workspaceId, false, saved);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 });
}
