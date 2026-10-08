import { createHash } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import { WorkbenchProfile, WorkbenchShellSaveInput, WorkbenchShellState, WorkbenchProjectCreateInput,
  WorkbenchContextSaveInput, WorkbenchArchiveInput, WorkbenchDraftSaveInput, NativeProjectQueryInput } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { readEditorDocument } from "./editor-documents";

type Db = Prisma.TransactionClient;
const conflict = () => new ApiException(409, "内容已被其他页面更新。当前输入仍保留，请重新读取后检查。");
const now = (date?: Date | null) => date?.getTime() ?? null;
const version = (revision?: number) => `novart-${revision ?? 0}`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function lockWorkspace(tx: Db, workspaceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "BrandWorkspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
}
async function lockProject(tx: Db, workspaceId: string, projectId: string, archivedAllowed = false) {
  const rows = await tx.$queryRaw<Array<{ id: string; archivedAt: Date | null; description: string | null }>>`
    SELECT "id", "archivedAt", "description" FROM "Project" WHERE "id" = ${projectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  if (!rows[0]) throw new ApiException(404, "项目不存在。");
  if (!archivedAllowed && rows[0].archivedAt) throw new ApiException(409, "项目已归档，请恢复后继续编辑。");
  return rows[0];
}
async function state(tx: Db, workspaceId: string, userId: string) {
  const [brand, person, user, workspace] = await Promise.all([
    tx.workbenchBrandDraft.findUnique({ where: { workspaceId } }),
    tx.workbenchUserState.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } }),
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } }),
    tx.brandWorkspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
  ]);
  return WorkbenchShellState.parse({ revision: (brand?.revision ?? 0) + (person?.revision ?? 0),
    profile: person?.profile ?? { nickname: (user.name ?? "").slice(0, 40), density: "comfortable", motion: "system" },
    brand: { name: workspace.name.slice(0, 60), colors: brand?.colors.length === 3 ? brand.colors : ["#7C5CFF", "#171717", "#F4F0FF"], font: brand?.font ?? "system", notes: brand?.notes ?? "" },
    favorites: person?.favorites ?? [],
  });
}
export async function readStudioState(workspaceId: string, userId: string) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  return state(prisma, workspaceId, userId);
}
export async function saveStudioState(workspaceId: string, userId: string, raw: unknown) {
  const input = WorkbenchShellSaveInput.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, input.group === "brand" ? "EDITOR" : "VIEWER");
  return prisma.$transaction(async tx => {
    await lockWorkspace(tx, workspaceId);
    const current = await state(tx, workspaceId, userId);
    if (current.revision !== input.revision) throw conflict();
    if (input.group === "brand") {
      const { name, ...draft } = input.brand;
      await tx.brandWorkspace.update({ where: { id: workspaceId }, data: { name } });
      await tx.workbenchBrandDraft.upsert({ where: { workspaceId }, create: { workspaceId, ...draft, revision: 1 }, update: { ...draft, revision: { increment: 1 } } });
    } else {
      const favorites = input.group === "favorites" ? [...new Set(input.favorites)] : current.favorites;
      if (input.group === "favorites") {
        const count = await tx.project.count({ where: { workspaceId, id: { in: favorites } } });
        if (count !== favorites.length) throw new ApiException(422, "收藏包含不属于当前品牌的项目。");
      }
      const profile = WorkbenchProfile.parse(input.group === "profile" ? input.profile : current.profile);
      await tx.workbenchUserState.upsert({ where: { userId_workspaceId: { userId, workspaceId } },
        create: { userId, workspaceId, profile, favorites, revision: 1 }, update: { profile, favorites, revision: { increment: 1 } } });
    }
    return state(tx, workspaceId, userId);
  });
}
export async function studioProjects(workspaceId: string, userId: string) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const rows = await prisma.project.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1000,
    select: { id: true, name: true, createdAt: true, archivedAt: true,
      workbenchState: { select: { archiveRevision: true, updatedAt: true } }, editorDocument: { select: { revision: true, updatedAt: true } } } });
  return { projects: rows.map(p => ({ projectId: p.id, projectName: p.name, version: version(p.editorDocument?.revision),
    createdAt: now(p.createdAt), updatedAt: Math.max(p.createdAt.getTime(), now(p.editorDocument?.updatedAt) ?? 0, now(p.workbenchState?.updatedAt) ?? 0),
    archivedAt: now(p.archivedAt), archiveRevision: p.workbenchState?.archiveRevision ?? 0, hasCanvas: !!p.editorDocument,
  })) };
}
export async function createStudioProject(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = WorkbenchProjectCreateInput.parse(raw);
  const creationKey = digest([workspaceId, userId, input.requestId]);
  const creationChecksum = digest([input.projectName, input.brief]);
  return prisma.$transaction(async tx => {
    await lockWorkspace(tx, workspaceId);
    const prior = await tx.workbenchProjectState.findUnique({ where: { creationKey } });
    if (prior) {
      if (prior.workspaceId !== workspaceId || prior.creationChecksum !== creationChecksum) throw conflict();
      return { projectId: prior.projectId };
    }
    const p = await tx.project.create({ data: { workspaceId, name: input.projectName, description: input.brief.slice(0, 2000),
      workbenchState: { create: { workspaceId, brief: input.brief, revision: input.brief ? 1 : 0, creationKey, creationChecksum } } } });
    return { projectId: p.id };
  });
}
export async function studioContext(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const { projectId } = NativeProjectQueryInput.parse(raw);
  const p = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { description: true, workbenchState: true } });
  if (!p) throw new ApiException(404, "项目不存在。");
  return { projectId, brief: p.workbenchState?.brief ?? p.description ?? "", notes: p.workbenchState?.notes ?? "", revision: p.workbenchState?.revision ?? 0, updatedAt: now(p.workbenchState?.updatedAt) };
}
export async function saveStudioContext(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = WorkbenchContextSaveInput.parse(raw);
  return prisma.$transaction(async tx => {
    await lockProject(tx, workspaceId, input.projectId);
    const row = await tx.workbenchProjectState.findUnique({ where: { projectId: input.projectId } });
    if ((row?.revision ?? 0) !== input.revision) throw conflict();
    const data = { brief: input.brief, notes: input.notes, revision: input.revision + 1 };
    const saved = await tx.workbenchProjectState.upsert({ where: { projectId: input.projectId }, create: { projectId: input.projectId, workspaceId, ...data }, update: data });
    return { projectId: input.projectId, ...data, updatedAt: now(saved.updatedAt) };
  });
}
export async function archiveStudioProject(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = WorkbenchArchiveInput.parse(raw);
  await prisma.$transaction(async tx => {
    const project = await lockProject(tx, workspaceId, input.projectId, true);
    const [doc, state] = await Promise.all([tx.editorDocument.findUnique({ where: { projectId: input.projectId }, select: { revision: true } }), tx.workbenchProjectState.findUnique({ where: { projectId: input.projectId } })]);
    if ((state?.archiveRevision ?? 0) !== input.revision || version(doc?.revision) !== input.projectVersion) throw conflict();
    await tx.project.update({ where: { id: input.projectId }, data: { archivedAt: input.archived ? new Date() : null } });
    await tx.workbenchProjectState.upsert({ where: { projectId: input.projectId }, create: { projectId: input.projectId, workspaceId, brief: project.description ?? "", archiveRevision: input.revision + 1 }, update: { archiveRevision: input.revision + 1 } });
  });
  return { projectId: input.projectId, archived: input.archived };
}
export async function studioStatus(workspaceId: string, userId: string, raw: unknown) {
  const { projectId } = NativeProjectQueryInput.parse(raw);
  const doc = await readEditorDocument(workspaceId, projectId, userId);
  const p = await prisma.project.findFirstOrThrow({ where: { id: projectId, workspaceId }, select: { name: true } });
  return { projectId, projectName: p.name, version: version(doc.revision), savedAt: doc.updatedAt ? Date.parse(doc.updatedAt) : null, saveError: null };
}

export function validateStudioDraft(form: Record<string, unknown> | null) {
  if (!form) return;
  const encoded = JSON.stringify(form);
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new ApiException(413, "草稿过大，请缩短内容。");
  // Text/model/ratio preferences can already persist. Image references are a
  // separate integration step; reject them instead of retaining transient URLs.
  const stack: Array<{ value: unknown; depth: number }> = [{ value: form, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 60) throw new ApiException(422, "草稿层级过深。");
    if (!value || typeof value !== "object") continue;
    for (const [key, item] of Object.entries(value)) {
      if (["url", "src", "imageUrl", "originalUrl", "thumbnail", "videoUrl", "fileUrl"].includes(key) && typeof item === "string" && item) throw new ApiException(422, "图片引用保存正在接入，请保留本页；文字草稿可以正常保存。");
      stack.push({ value: item, depth: depth + 1 });
    }
  }
}
export async function studioDraft(workspaceId: string, userId: string, raw: unknown) {
  const { projectId } = NativeProjectQueryInput.parse(raw);
  await readEditorDocument(workspaceId, projectId, userId);
  const row = await prisma.workbenchChatDraft.findUnique({ where: { userId_projectId: { userId, projectId } } });
  return { projectId, revision: row?.revision ?? 0, inputForm: row?.inputForm ?? null, updatedAt: now(row?.updatedAt) };
}
export async function saveStudioDraft(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = WorkbenchDraftSaveInput.parse(raw); validateStudioDraft(input.inputForm);
  return prisma.$transaction(async tx => {
    await lockProject(tx, workspaceId, input.projectId);
    const where = { userId_projectId: { userId, projectId: input.projectId } };
    const old = await tx.workbenchChatDraft.findUnique({ where });
    if ((old?.revision ?? 0) !== input.revision) throw conflict();
    const data = { revision: input.revision + 1, inputForm: input.inputForm as Prisma.InputJsonValue ?? Prisma.DbNull };
    const row = await tx.workbenchChatDraft.upsert({ where, create: { userId, projectId: input.projectId, ...data }, update: data });
    return { projectId: input.projectId, revision: row.revision, inputForm: row.inputForm, updatedAt: now(row.updatedAt) };
  });
}
