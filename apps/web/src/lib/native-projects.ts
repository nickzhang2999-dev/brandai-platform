import { createHash } from "node:crypto";
import { prisma } from "@brandai/db";
import { NativeProjectQueryInput, NativeProjectListInput, NativeProjectRenameInput, NativeProjectSaveInput } from "@brandai/contracts";
import { requireWorkspaceRole } from "./workspace";
import { readEditorDocument, saveEditorDocument } from "./editor-documents";
import { EditorDocumentError } from "./editor-document-codec";

const version = (revision: number) => `novart-${revision}`;

/** Native retries carry a version and canvas, but no mutation UUID. A stable,
 * user/workspace/project-scoped UUID permits only an identical lost-response
 * retry. It does not read or replace the caller's expected revision. */
export function nativeDocumentMutation(userId: string, workspaceId: string, input: NativeProjectSaveInput) {
  const hex = createHash("sha256").update(JSON.stringify([
    "novart-native-full-save-v1", userId, workspaceId, input.projectId, input.version, input.canvas,
  ])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex.charAt(16), 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function queryNativeProject(workspaceId: string, userId: string, raw: unknown) {
  const { projectId } = NativeProjectQueryInput.parse(raw);
  const doc = await readEditorDocument(workspaceId, projectId, userId);
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { name: true, createdAt: true } });
  if (!project) throw new EditorDocumentError(404, "PROJECT_NOT_FOUND", "项目不存在。");
  return {
    projectId, projectName: project.name, canvas: doc.canvas, version: version(doc.revision),
    createdAt: project.createdAt.getTime(), updatedAt: doc.updatedAt ? Date.parse(doc.updatedAt) : project.createdAt.getTime(),
    validProjectId: true, projectType: 3, readOnly: doc.readOnly,
    // The product uses complete snapshots, not the vendor's access-ticket or
    // incremental-evidence services. These are feature flags, not saved data.
    canvasV2Gray: false, canvasEvidenceEnabled: false,
  };
}

export async function saveNativeProject(workspaceId: string, userId: string, raw: unknown) {
  const input = NativeProjectSaveInput.parse(raw);
  const doc = await saveEditorDocument(workspaceId, input.projectId, userId, {
    format: "novart-native-v1", canvas: input.canvas, revision: Number(input.version.slice(7)),
    mutationId: nativeDocumentMutation(userId, workspaceId, input),
  });
  return { projectId: doc.projectId, version: version(doc.revision), validProjectId: true };
}

export async function listNativeProjects(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const { page, pageSize } = NativeProjectListInput.parse(raw);
  // Never read full multi-megabyte canvases for a library page.
  const where = { workspaceId, archivedAt: null };
  const [rows, total] = await prisma.$transaction([
    prisma.project.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize,
      select: { id: true, name: true, createdAt: true, editorDocument: { select: { revision: true, updatedAt: true } } } }),
    prisma.project.count({ where }),
  ]);
  return { data: rows.map(p => ({ projectId: p.id, projectName: p.name,
    version: version(p.editorDocument?.revision ?? 0), createdAt: p.createdAt.getTime(),
    updatedAt: (p.editorDocument?.updatedAt ?? p.createdAt).getTime(),
    hasCanvas: !!p.editorDocument, validProjectId: true, projectType: 3,
  })), page, total, hasMore: page * pageSize < total };
}

export async function renameNativeProject(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const { projectId, projectName } = NativeProjectRenameInput.parse(raw);
  // Name edits are separate from document autosaves, as in the native client.
  // updateMany's scoped predicate also serializes with archive writes.
  const result = await prisma.project.updateMany({
    where: { id: projectId, workspaceId, archivedAt: null }, data: { name: projectName },
  });
  if (!result.count) throw new EditorDocumentError(409, "PROJECT_UNAVAILABLE", "项目不存在或已归档，未修改名称。");
  return { projectId, projectName };
}
