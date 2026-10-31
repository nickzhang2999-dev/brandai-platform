import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma, Prisma } from "@brandai/db";
import { StudioWritingAssetReferenceInput, StudioWritingDocument, StudioWritingGenerateInput, StudioWritingReference,
  StudioWritingResult, StudioWritingSaveInput, StudioWritingStyle, StudioWritingStyleExtractInput, StudioWritingStyleSaveInput,
  StudioWritingTask, StudioWritingVersion, STUDIO_WRITING_FILE_MAX_BYTES, type StudioProjectContextSnapshot } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireStudioMaterialProject } from "./studio-materials";
import { copywritingEnabled } from "./studio-copywriting-provider";
import { freezeStudioProjectContext } from "./studio-project-context";
import { lockTaskWorkspace } from "./workspace-task-lock";

export const WRITING_KIND = "STUDIO_WRITING";
export const WRITING_TTL = 6 * 60_000;
export const WRITING_EXPIRED = "任务等待或执行超时；系统不会自动重复调用模型，请确认后重新提交。";
export const writingHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const writingDocumentId = (workspaceId: string, projectId: string, userId: string) => "write_" + writingHash([workspaceId, projectId, userId]);
export const writingTaskId = (workspaceId: string, projectId: string, userId: string, mutationId: string) => "wtask_" + writingHash([workspaceId, projectId, userId, mutationId]);
export type WritingScope = { workspaceId: string; projectId: string; userId: string };
export type WritingInput = { userId: string; documentId: string; operation: "GENERATE" | "STYLE_EXTRACT" | "REFERENCE_PARSE";
  request: unknown; payloadHash: string; referenceId?: string; context?: { draft: { title: string; text: string; revision: number };
    style: StudioWritingStyle | null; references: { id: string; sha256: string }[]; history: { role: string; text: string }[];
    projectContext?: StudioProjectContextSnapshot } };
export const writingJson = (value: unknown) => value as Prisma.InputJsonValue;
const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(work, { maxWait: 1000, timeout: 1500 });
const idFor = (s: WritingScope) => writingDocumentId(s.workspaceId, s.projectId, s.userId);
const taskWhere = (s: WritingScope) => ({ workspaceId: s.workspaceId, refId: s.projectId, kind: WRITING_KIND, inputJson: { path: ["userId"], equals: s.userId } });
function nullByte(value: unknown) { if (JSON.stringify(value).includes("\\u0000")) throw new ApiException(422, "内容不能包含空字符。"); }
export async function requireWritingScope(s: WritingScope, write = false) {
  const user = await prisma.user.findUnique({ where: { id: s.userId }, select: { isActive: true } });
  if (!user?.isActive) throw new ApiException(403, "账号不可用。");
  await requireStudioMaterialProject(s.workspaceId, s.userId, s.projectId, write);
}
async function lock(tx: Prisma.TransactionClient, key: string) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`; }
async function ensureDocument(tx: Prisma.TransactionClient, s: WritingScope) {
  return tx.studioWritingDocument.upsert({ where: { id: idFor(s) }, create: { id: idFor(s), ...s }, update: {} });
}
export function writingDocumentView(row: { id: string; title: string; text: string; revision: number; updatedAt: Date } | null, s: WritingScope) {
  return StudioWritingDocument.parse(row ? { id: row.id, title: row.title, text: row.text, revision: row.revision, updatedAt: row.updatedAt.toISOString() }
    : { id: idFor(s), title: "未命名文案", text: "", revision: 0, updatedAt: null });
}
export function writingVersionView(row: { id: string; revision: number; title: string; text: string; operation: string; createdAt: Date }) {
  return StudioWritingVersion.parse({ id: row.id, revision: row.revision, title: row.title, text: row.text, operation: row.operation, createdAt: row.createdAt.toISOString() });
}
export function writingStyleView(row: { revision: number; rules: unknown; examples: unknown; confirmedAt: Date | null } | null) {
  return StudioWritingStyle.parse(row ? { revision: row.revision, rules: row.rules, examples: row.examples, confirmedAt: row.confirmedAt?.toISOString() ?? null }
    : { revision: 0, rules: [], examples: [], confirmedAt: null });
}
export function writingTaskView(row: { id: string; inputJson: unknown; resultJson: unknown; status: string; progress: number; error: string | null; createdAt: Date; expiresAt: Date | null }) {
  const input = row.inputJson as WritingInput;
  const request = input.operation === "GENERATE" ? StudioWritingGenerateInput.parse(input.request)
    : input.operation === "STYLE_EXTRACT" ? StudioWritingStyleExtractInput.parse(input.request) : null;
  return StudioWritingTask.parse({ id: row.id, mutationId: (input.request as { mutationId: string }).mutationId, operation: input.operation,
    input: request, status: row.status, progress: row.progress, error: row.error, createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt!.toISOString(), result: row.status === "SUCCEEDED" ? StudioWritingResult.parse(row.resultJson) : null });
}
export function writingReferenceView(row: { id: string; name: string; mimeType: string; sha256: string; sizeBytes: number; kind: string; status: string; error: string | null; segments: unknown; truncated: boolean; createdAt: Date }, s: WritingScope) {
  return StudioWritingReference.parse({ id: row.id, name: row.name, mimeType: row.mimeType, sha256: row.sha256, sizeBytes: row.sizeBytes,
    kind: row.kind, status: row.status, error: row.error, segments: row.segments, truncated: row.truncated, createdAt: row.createdAt.toISOString(),
    imageUrl: row.kind === "IMAGE" && row.status === "READY" ? `/api/workspaces/${s.workspaceId}/projects/${s.projectId}/studio-writing/references/${row.id}/content` : null });
}
export async function expireWriting(workspaceId?: string) {
  await transaction(async tx => {
    const rows = await tx.asyncTask.findMany({ where: { kind: WRITING_KIND, ...(workspaceId ? { workspaceId } : {}),
      status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } }, select: { id: true }, take: 100 });
    if (!rows.length) return;
    const ids = rows.map(r => r.id);
    await tx.asyncTask.updateMany({ where: { id: { in: ids }, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: WRITING_EXPIRED } });
    await tx.studioWritingReference.updateMany({ where: { taskId: { in: ids }, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: WRITING_EXPIRED, body: null } });
  });
}
export async function writingState(s: WritingScope) {
  await requireWritingScope(s); await expireWriting(s.workspaceId);
  const documentId = idFor(s);
  const [document, versions, messages, references, style, tasks] = await Promise.all([
    prisma.studioWritingDocument.findFirst({ where: { id: documentId, ...s } }),
    prisma.studioWritingVersion.findMany({ where: { documentId }, orderBy: { revision: "desc" }, take: 20 }),
    prisma.studioWritingMessage.findMany({ where: { documentId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }),
    prisma.studioWritingReference.findMany({ where: { documentId, deletedAt: null }, orderBy: { createdAt: "asc" }, take: 30 }),
    prisma.studioWritingStyle.findUnique({ where: { workspaceId: s.workspaceId } }),
    prisma.asyncTask.findMany({ where: taskWhere(s), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30 }),
  ]);
  return { enabled: copywritingEnabled(), document: writingDocumentView(document, s), versions: versions.map(writingVersionView),
    messages: messages.reverse().map(r => ({ id: r.id, role: r.role, text: r.text, taskId: r.taskId, citations: r.citations, createdAt: r.createdAt.toISOString() })),
    references: references.map(r => writingReferenceView(r, s)), style: writingStyleView(style), tasks: tasks.map(writingTaskView) };
}
export async function saveWriting(s: WritingScope, raw: unknown) {
  const request = StudioWritingSaveInput.parse(raw); nullByte(request); await requireWritingScope(s, true);
  return transaction(async tx => {
    await lock(tx, "writing:" + idFor(s));
    const document = await ensureDocument(tx, s);
    const payloadHash = writingHash(request);
    const previous = await tx.studioWritingVersion.findUnique({ where: { documentId_mutationId: { documentId: document.id, mutationId: request.mutationId } } });
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new ApiException(409, "这次保存标识已用于其它内容，请重新保存。");
      return { document: writingDocumentView(document, s), version: writingVersionView(previous) };
    }
    if (document.revision !== request.expectedRevision) throw new ApiException(409, "当前稿已更新，请读取最新版本后再保存。");
    let text = document.text, title = document.title;
    if (request.operation === "SAVE") { text = request.text; title = request.title; }
    if (request.operation === "REPLACE") {
      const { start, end, text: original } = request.selection;
      if (end > text.length || text.slice(start, end) !== original) throw new ApiException(409, "选段已变化，请重新选择当前原文。");
      text = text.slice(0, start) + request.replacement + text.slice(end);
    }
    if (request.operation === "RESTORE") {
      const version = await tx.studioWritingVersion.findFirst({ where: { id: request.versionId, documentId: document.id } });
      if (!version) throw new ApiException(404, "版本不存在。");
      text = version.text; title = version.title;
    }
    if (text.length > 60000) throw new ApiException(413, "当前稿超过六万字，请拆分项目。");
    const updated = await tx.studioWritingDocument.update({ where: { id: document.id, revision: request.expectedRevision }, data: { text, title, revision: { increment: 1 } } });
    const version = await tx.studioWritingVersion.create({ data: { documentId: document.id, revision: updated.revision, mutationId: request.mutationId, payloadHash, title, text, operation: request.operation } });
    return { document: writingDocumentView(updated, s), version: writingVersionView(version) };
  });
}
export async function writingVersions(s: WritingScope, beforeRevision?: number) {
  await requireWritingScope(s);
  const rows = await prisma.studioWritingVersion.findMany({ where: { documentId: idFor(s), ...(beforeRevision === undefined ? {} : { revision: { lt: beforeRevision } }) }, orderBy: { revision: "desc" }, take: 21 });
  return { versions: rows.slice(0, 20).map(writingVersionView), hasMore: rows.length > 20 };
}
export async function writingMessages(s: WritingScope, beforeId?: string) {
  await requireWritingScope(s); const documentId = idFor(s);
  const cursor = beforeId ? await prisma.studioWritingMessage.findFirst({ where: { id: beforeId, documentId } }) : null;
  if (beforeId && !cursor) throw new ApiException(404, "消息不存在。");
  const rows = await prisma.studioWritingMessage.findMany({ where: { documentId, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51 });
  return { messages: rows.slice(0, 50).reverse().map(r => ({ id: r.id, role: r.role, text: r.text, taskId: r.taskId, citations: r.citations, createdAt: r.createdAt.toISOString() })), hasMore: rows.length > 50 };
}
export async function writingTask(s: WritingScope, taskId: string) {
  await requireWritingScope(s); await expireWriting(s.workspaceId);
  const row = await prisma.asyncTask.findFirst({ where: { id: taskId, ...taskWhere(s) } });
  if (!row) throw new ApiException(404, "任务不存在。");
  return writingTaskView(row);
}
export async function lookupWritingTask(s: WritingScope, mutationId: string) {
  await requireWritingScope(s); await expireWriting(s.workspaceId);
  const row = await prisma.asyncTask.findFirst({ where: { id: writingTaskId(s.workspaceId, s.projectId, s.userId, mutationId), ...taskWhere(s) } });
  return { task: row ? writingTaskView(row) : null };
}
export async function readWritingStyle(s: WritingScope) {
  await requireWritingScope(s);
  return writingStyleView(await prisma.studioWritingStyle.findUnique({ where: { workspaceId: s.workspaceId } }));
}
export async function saveWritingStyle(s: WritingScope, raw: unknown) {
  const request = StudioWritingStyleSaveInput.parse(raw); nullByte(request); await requireWritingScope(s, true);
  return transaction(async tx => {
    await lock(tx, "writing-style:" + s.workspaceId);
    const style = await tx.studioWritingStyle.upsert({ where: { workspaceId: s.workspaceId }, create: { workspaceId: s.workspaceId }, update: {} });
    const previous = await tx.studioWritingStyleVersion.findUnique({ where: { workspaceId_userId_mutationId: { workspaceId: s.workspaceId, userId: s.userId, mutationId: request.mutationId } } });
    const payloadHash = writingHash(request);
    if (previous) { if (previous.payloadHash !== payloadHash) throw new ApiException(409, "风格保存标识已用于其它内容。"); return writingStyleView(style); }
    if (style.revision !== request.expectedRevision) throw new ApiException(409, "品牌风格已更新，请先读取最新版本。");
    const confirmedAt = new Date();
    const updated = await tx.studioWritingStyle.update({ where: { workspaceId: s.workspaceId, revision: request.expectedRevision }, data: { revision: { increment: 1 }, rules: request.rules, examples: request.examples, confirmedAt } });
    await tx.studioWritingStyleVersion.create({ data: { workspaceId: s.workspaceId, revision: updated.revision, userId: s.userId, mutationId: request.mutationId, payloadHash, rules: request.rules, examples: request.examples, confirmedAt } });
    return writingStyleView(updated);
  });
}
async function admission(tx: Prisma.TransactionClient, s: WritingScope, operation: string) {
  await lock(tx, "writing-intake:" + s.workspaceId);
  const active = await tx.asyncTask.count({ where: { ...taskWhere(s), status: { in: ["PENDING", "RUNNING"] }, expiresAt: { gt: new Date() }, ...(operation === "REFERENCE_PARSE" ? {} : { AND: { NOT: { inputJson: { path: ["operation"], equals: "REFERENCE_PARSE" } } } }) } });
  if (active >= (operation === "REFERENCE_PARSE" ? 10 : 1)) throw new ApiException(409, "已有任务正在处理，请先查看结果。");
  const recent = await tx.asyncTask.count({ where: { workspaceId: s.workspaceId, kind: WRITING_KIND, createdAt: { gt: new Date(Date.now() - 60_000) } } });
  if (recent >= 15) throw new ApiException(429, "提交较多，请稍等一分钟。");
}
export async function submitWriting(s: WritingScope, raw: unknown, styleExtract = false) {
  const request = styleExtract ? StudioWritingStyleExtractInput.parse(raw) : StudioWritingGenerateInput.parse(raw);
  nullByte(request); await requireWritingScope(s, true);
  const id = writingTaskId(s.workspaceId, s.projectId, s.userId, request.mutationId);
  const operation = styleExtract ? "STYLE_EXTRACT" : "GENERATE";
  const payloadHash = writingHash([operation, request]);
  return writingTaskView(await transaction(async tx => {
    await lockTaskWorkspace(tx, s.workspaceId);
    await lock(tx, "writing:" + idFor(s));
    const prior = await tx.asyncTask.findUnique({ where: { id } });
    if (prior) { if ((prior.inputJson as unknown as WritingInput).payloadHash !== payloadHash) throw new ApiException(409, "任务标识已用于其它内容。"); return prior; }
    const contextRevision = styleExtract ? undefined : (request as StudioWritingGenerateInput).projectContextRevision;
    const projectContext = contextRevision === undefined ? undefined
      : await freezeStudioProjectContext(tx, s.workspaceId, s.projectId, contextRevision);
    if (!copywritingEnabled()) throw new ApiException(503, "文案模型尚未配置，请管理员完成接入。");
    await admission(tx, s, operation);
    const document = await ensureDocument(tx, s);
    if (!styleExtract) {
      const generation = request as StudioWritingGenerateInput;
      if (document.revision !== generation.expectedRevision) throw new ApiException(409, "当前稿已更新，请先保存并读取最新稿件。");
      if (generation.selection && (generation.selection.end > document.text.length || document.text.slice(generation.selection.start, generation.selection.end) !== generation.selection.text)) throw new ApiException(409, "选段与当前稿不一致，请重新选择。");
    }
    const references = await tx.studioWritingReference.findMany({ where: { id: { in: request.referenceIds }, documentId: document.id, deletedAt: null, status: "READY" } });
    if (references.length !== request.referenceIds.length) throw new ApiException(422, "所选资料不存在、尚未解析完成或不属于当前用户与项目。");
    if (references.filter(r => r.kind === "IMAGE").length > 4) throw new ApiException(422, "每次最多选择四张图片。");
    let style: StudioWritingStyle | null = null;
    const revision = styleExtract ? null : (request as StudioWritingGenerateInput).styleRevision;
    if (revision !== null) {
      const current = await tx.studioWritingStyle.findUnique({ where: { workspaceId: s.workspaceId } });
      if (!current?.confirmedAt || current.revision !== revision) throw new ApiException(409, "所选品牌风格尚未确认或已更新。");
      style = writingStyleView(current);
    }
    const messages = await tx.studioWritingMessage.findMany({ where: { documentId: document.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8 });
    const input: WritingInput = { userId: s.userId, documentId: document.id, operation, request, payloadHash,
      context: { draft: { title: document.title, text: document.text, revision: document.revision }, style,
        ...(projectContext ? { projectContext } : {}),
        references: references.map(r => ({ id: r.id, sha256: r.sha256 })), history: messages.reverse().map(m => ({ role: m.role, text: m.text.slice(0, 3000) })) } };
    const task = await tx.asyncTask.create({ data: { id, workspaceId: s.workspaceId, refId: s.projectId, kind: WRITING_KIND, jobId: id,
      inputJson: writingJson(input), expiresAt: new Date(Date.now() + WRITING_TTL) } });
    if (!styleExtract) await tx.studioWritingMessage.create({ data: { documentId: document.id, taskId: id, role: "user", text: request.prompt } });
    return task;
  }));
}
export type WritingUpload = { mutationId: string; name: string; mimeType: string; body: Buffer };
const documentMime: Record<string, string> = { txt: "text/plain", md: "text/markdown", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
export function writingFileType(name: string, mimeType: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (documentMime[extension]) return { kind: "DOCUMENT", mimeType: documentMime[extension] };
  const imageMime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  if (imageMime[extension] && (!mimeType || mimeType === imageMime[extension])) return { kind: "IMAGE", mimeType: imageMime[extension] };
  throw new ApiException(422, "仅支持 PNG/JPEG/WebP 图片和 TXT/MD/PDF/DOCX/PPTX 文本资料。");
}
export async function uploadWritingReference(s: WritingScope, upload: WritingUpload | zAsset) {
  await requireWritingScope(s, true);
  z.string().uuid().parse(upload.mutationId);
  const assetInput = "assetId" in upload ? StudioWritingAssetReferenceInput.parse(upload) : null;
  const body = "body" in upload ? upload.body : null;
  if (body && (!body.length || body.length > STUDIO_WRITING_FILE_MAX_BYTES)) throw new ApiException(413, "单份资料须大于零且不超过 10 MiB。");
  if (!upload.name.trim() || upload.name.length > 200 || /[\u0000-\u001f]/.test(upload.name)) throw new ApiException(422, "资料名称无效。");
  const type = assetInput ? { kind: "IMAGE", mimeType: "image/jpeg" } : writingFileType(upload.name, (upload as WritingUpload).mimeType);
  const sha256 = body ? createHash("sha256").update(body).digest("hex") : assetInput!.assetSha256;
  const payloadHash = writingHash([upload.name, type.mimeType, sha256, assetInput?.assetId ?? null]);
  const id = writingTaskId(s.workspaceId, s.projectId, s.userId, upload.mutationId);
  const result = await transaction(async tx => {
    await lockTaskWorkspace(tx, s.workspaceId);
    await lock(tx, "writing:" + idFor(s));
    const priorTask = await tx.asyncTask.findUnique({ where: { id } });
    if (priorTask) {
      const prior = await tx.studioWritingReference.findFirst({ where: { taskId: id, documentId: idFor(s) } });
      if (!prior || prior.payloadHash !== payloadHash || prior.deletedAt) throw new ApiException(409, "上传标识已使用或资料已移除，请重新选择文件。");
      return { reference: prior, task: priorTask };
    }
    await admission(tx, s, "REFERENCE_PARSE");
    const document = await ensureDocument(tx, s);
    const capacity = await tx.studioWritingReference.aggregate({ where: { documentId: document.id, deletedAt: null }, _count: true, _sum: { sizeBytes: true } });
    if (capacity._count >= 30 || (capacity._sum.sizeBytes ?? 0) + (body?.length ?? STUDIO_WRITING_FILE_MAX_BYTES) > 64 * 1024 * 1024) throw new ApiException(413, "当前文案最多保存三十份资料、合计 64 MiB，请先移除不用的资料。");
    if (assetInput) {
      const asset = await tx.asset.findFirst({ where: { id: assetInput.assetId, workspaceId: s.workspaceId, deprecatedAt: null, availableForGeneration: true, projectLinks: { some: { projectId: s.projectId, project: { workspaceId: s.workspaceId } } } }, select: { id: true } });
      if (!asset) throw new ApiException(404, "图片不属于当前品牌项目或已失效。");
    }
    const referenceId = "wref_" + writingHash([document.id, upload.mutationId]);
    const input: WritingInput = { userId: s.userId, documentId: document.id, operation: "REFERENCE_PARSE", request: { mutationId: upload.mutationId }, referenceId, payloadHash };
    const task = await tx.asyncTask.create({ data: { id, workspaceId: s.workspaceId, refId: s.projectId, kind: WRITING_KIND, jobId: id, inputJson: writingJson(input), expiresAt: new Date(Date.now() + WRITING_TTL) } });
    const reference = await tx.studioWritingReference.create({ data: { id: referenceId, documentId: document.id, mutationId: upload.mutationId, payloadHash, taskId: id,
      name: upload.name, mimeType: type.mimeType, sha256, sizeBytes: body?.length ?? STUDIO_WRITING_FILE_MAX_BYTES, kind: type.kind, body: body ? new Uint8Array(body) : null, assetId: assetInput?.assetId ?? null } });
    return { reference, task };
  });
  return { reference: writingReferenceView(result.reference, s), task: writingTaskView(result.task) };
}
type zAsset = { mutationId: string; assetId: string; assetSha256: string; name: string };
export async function deleteWritingReference(s: WritingScope, id: string) {
  await requireWritingScope(s, true);
  await transaction(async tx => {
    await lock(tx, "writing:" + idFor(s));
    const reference = await tx.studioWritingReference.findFirst({ where: { id, documentId: idFor(s) } });
    if (!reference) throw new ApiException(404, "资料不存在。");
    if (reference.deletedAt) return;
    await tx.studioWritingReference.update({ where: { id }, data: { deletedAt: new Date(), body: null, segments: [] } });
    await tx.asyncTask.updateMany({ where: { id: reference.taskId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: "资料已由用户移除。" } });
  });
}
export async function writingReferenceContent(s: WritingScope, id: string) {
  await requireWritingScope(s);
  const row = await prisma.studioWritingReference.findFirst({ where: { id, documentId: idFor(s), deletedAt: null, status: "READY", kind: "IMAGE" } });
  if (!row?.body) throw new ApiException(404, "图片不存在或尚未准备完成。");
  if (row.assetId) await requireWritingAsset(s, row.assetId);
  if (createHash("sha256").update(row.body).digest("hex") !== row.sha256) throw new ApiException(409, "图片内容校验失败。");
  return { bytes: row.body, mimeType: row.mimeType };
}
/** Call only after requireWritingScope; cached bytes never bypass revocation. */
export async function requireWritingAsset(s: WritingScope, assetId: string) {
  const row = await prisma.asset.findFirst({ where: { id: assetId, workspaceId: s.workspaceId, deprecatedAt: null, availableForGeneration: true,
    projectLinks: { some: { projectId: s.projectId, project: { workspaceId: s.workspaceId } } } }, select: { url: true, storageKey: true } });
  if (!row) throw new ApiException(404, "所选项目图片已失效。");
  return row;
}
