import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@brandai/db";
import { StudioProjectContextSaveInput, StudioProjectContextSnapshot, StudioProjectContextView,
  type StudioProjectContextIssue } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireStudioMaterialProject } from "./studio-materials";
import { requireArtifactWrite } from "./studio-generation-artifacts";
import { requireTrustedStudioBrandProjectMaterial } from "./studio-brand-materials";
import { resolveStudioEditSource } from "./studio-generation-edit";

type Db = Prisma.TransactionClient;
type Source = { assetId: string; assetSha256: string; width: number; height: number; versionId: string | null };
const emptyFacts = { goal: "", audience: "", approvedCopy: "", visualRequirements: "" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function stored(db: Db, workspaceId: string, projectId: string) {
  const row = await db.workbenchProjectState.findUnique({ where: { projectId }, select: { workspaceId: true, contextRevision: true, contextJson: true, contextUpdatedAt: true } });
  if (row && row.workspaceId !== workspaceId) throw new ApiException(404, "项目资料不存在。");
  const snapshot = StudioProjectContextSnapshot.parse(row?.contextJson ?? { projectId, revision: 0, facts: emptyFacts, materials: [], master: null, updatedAt: null });
  if (snapshot.projectId !== projectId || snapshot.revision !== (row?.contextRevision ?? 0)) throw new ApiException(409, "项目资料版本不一致，请重新打开项目核对。");
  return snapshot;
}
async function checkSource(db: Db, workspaceId: string, projectId: string, source: Source) {
  const material = await requireTrustedStudioBrandProjectMaterial(db, workspaceId, projectId, source.assetId, source.assetSha256);
  if (material.width !== source.width || material.height !== source.height || material.generationVersionId !== source.versionId) throw new ApiException(422, "素材尺寸或版本已经变化。");
}
async function issues(db: Db, workspaceId: string, projectId: string, snapshot: StudioProjectContextSnapshot) {
  const result: StudioProjectContextIssue[] = [];
  for (const entry of [...snapshot.materials.map(source => ({ source, scope: "material" as const })), ...(snapshot.master ? [{ source: snapshot.master, scope: "master" as const }] : [])]) {
    try { await checkSource(db, workspaceId, projectId, entry.source); }
    catch (error) {
      if (!(error instanceof ApiException) || ![404, 409, 422].includes(error.status)) throw error;
      result.push({ scope: entry.scope, assetId: entry.source.assetId, code: error.status === 404 ? "SOURCE_UNAVAILABLE" : "SOURCE_CHANGED",
        message: `${entry.scope === "master" ? "主稿" : "素材"}「${entry.source.name}」已失效或版本变化，请重新选择；原记录仍保留。` });
    }
  }
  return result;
}
async function view(db: Db, workspaceId: string, snapshot: StudioProjectContextSnapshot) {
  return StudioProjectContextView.parse({ ...snapshot, issues: await issues(db, workspaceId, snapshot.projectId, snapshot) });
}

export async function readStudioProjectContext(workspaceId: string, userId: string, projectId: string) {
  await requireStudioMaterialProject(workspaceId, userId, projectId);
  return view(prisma, workspaceId, await stored(prisma, workspaceId, projectId));
}

/** No external I/O. Independent revision + scoped immutable mutation receipt;
 * never updates brief, notes, canvas, workflow or material permissions. */
export async function saveStudioProjectContext(workspaceId: string, userId: string, projectId: string, raw: unknown) {
  const input = StudioProjectContextSaveInput.parse(raw);
  await requireStudioMaterialProject(workspaceId, userId, projectId, true);
  const payloadHash = hash(input);
  return prisma.$transaction(async db => {
    await requireArtifactWrite(db, workspaceId, projectId, userId);
    const current = await stored(db, workspaceId, projectId);
    const identity = { workspaceId, projectId, userId, mutationId: input.mutationId };
    const old = await db.studioProjectContextMutation.findUnique({ where: { workspaceId_projectId_userId_mutationId: identity } });
    if (old) {
      if (old.payloadHash !== payloadHash) throw new ApiException(409, "同一次保存不能更换项目资料内容。");
      if (old.revision !== current.revision) throw new ApiException(409, "这次修改已经保存，之后项目资料又有更新，请重新读取最新版本。");
      return view(db, workspaceId, current);
    }
    if (current.revision !== input.expectedRevision) throw new ApiException(409, "项目资料已被其他操作更新，当前输入仍保留，请读取最新版本后再保存。");
    const materials: StudioProjectContextSnapshot["materials"] = [];
    for (const item of input.materials) {
      try {
        const material = await requireTrustedStudioBrandProjectMaterial(db, workspaceId, projectId, item.assetId, item.assetSha256);
        const prior = current.materials.find(old => old.assetId === item.assetId && old.assetSha256 === item.assetSha256);
        materials.push(prior ? { ...prior, role: item.role } : { ...item, name: material.fileName, width: material.width, height: material.height, versionId: material.generationVersionId });
      } catch (error) {
        const retained = current.materials.find(old => old.assetId === item.assetId && old.assetSha256 === item.assetSha256);
        if (!(error instanceof ApiException) || ![404, 409, 422].includes(error.status) || !retained) throw error;
        materials.push({ ...retained, role: item.role });
      }
    }
    let master: StudioProjectContextSnapshot["master"] = null;
    if (input.master) {
      const item = input.master;
      let material;
      try { material = await requireTrustedStudioBrandProjectMaterial(db, workspaceId, projectId, item.assetId, item.assetSha256); }
      catch (error) {
        const retained = current.master;
        if (!(error instanceof ApiException) || ![404, 409, 422].includes(error.status) || !retained || retained.assetId !== item.assetId
          || retained.assetSha256 !== item.assetSha256 || (item.shapeId ?? null) !== retained.shapeId || item.versionId && item.versionId !== retained.versionId) throw error;
        master = retained;
      }
      if (material) {
        const prior = current.master;
        const sameMaster = prior && prior.assetId === item.assetId && prior.assetSha256 === item.assetSha256 && prior.shapeId === (item.shapeId ?? null)
          && (item.versionId === undefined || item.versionId === prior.versionId);
        if (!sameMaster && item.versionId !== undefined && item.versionId !== material.generationVersionId) throw new ApiException(422, "选中的主稿版本不匹配。");
        if (item.shapeId && !sameMaster) {
          const document = await db.editorDocument.findUnique({ where: { projectId } });
          if (!document || document.workspaceId !== workspaceId || document.revision !== input.documentRevision) throw new ApiException(409, "主稿所在画布已经变化，请先保存画布后再确认主稿。");
          const actual = await resolveStudioEditSource(db, workspaceId, projectId, { shapeId: item.shapeId, assetSha256: item.assetSha256 }, document.canvas, true);
          if (actual.snapshot.assetId !== item.assetId || actual.snapshot.width !== material.width || actual.snapshot.height !== material.height) throw new ApiException(422, "主稿与保存的画布原图不一致。");
        }
        master = sameMaster ? prior : { assetId: item.assetId, assetSha256: item.assetSha256, shapeId: item.shapeId ?? null,
          versionId: material.generationVersionId, name: material.fileName, width: material.width, height: material.height };
      }
    }
    const snapshot = StudioProjectContextSnapshot.parse({ projectId, revision: current.revision + 1, facts: input.facts, materials, master, updatedAt: new Date().toISOString() });
    await db.workbenchProjectState.upsert({ where: { projectId },
      create: { projectId, workspaceId, contextRevision: snapshot.revision, contextJson: snapshot as unknown as Prisma.InputJsonValue, contextUpdatedAt: new Date(snapshot.updatedAt!) },
      update: { contextRevision: snapshot.revision, contextJson: snapshot as unknown as Prisma.InputJsonValue, contextUpdatedAt: new Date(snapshot.updatedAt!) } });
    await db.studioProjectContextMutation.create({ data: { ...identity, payloadHash, revision: snapshot.revision, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
    return view(db, workspaceId, snapshot);
  }, { timeout: 10_000 });
}

/** Internal helpers: caller authorizes the project/current actor. Freezing is
 * opt-in at intake; later revision edits do not rewrite already accepted jobs. */
export async function freezeStudioProjectContext(db: Db, workspaceId: string, projectId: string, expectedRevision: number) {
  const snapshot = await stored(db, workspaceId, projectId);
  if (snapshot.revision !== expectedRevision) throw new ApiException(409, "项目资料已更新，请核对最新资料后重新发送。");
  await assertStudioProjectContextSources(db, workspaceId, projectId, snapshot);
  return snapshot;
}
export async function assertStudioProjectContextSources(db: Db, workspaceId: string, projectId: string, raw: unknown, lock = false) {
  const snapshot = StudioProjectContextSnapshot.parse(raw);
  if (snapshot.projectId !== projectId) throw new ApiException(404, "项目资料归属不匹配。");
  if (lock) {
    const assetIds = [...new Set([...snapshot.materials.map(item => item.assetId), ...(snapshot.master ? [snapshot.master.assetId] : [])])].sort();
    for (const assetId of assetIds) {
      await db.$queryRaw`SELECT "id" FROM "Asset" WHERE "id" = ${assetId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
      await db.$queryRaw`SELECT "assetId" FROM "ProjectAsset" WHERE "assetId" = ${assetId} AND "projectId" = ${projectId} FOR SHARE`;
    }
  }
  if ((await issues(db, workspaceId, projectId, snapshot)).length) throw new ApiException(409, "沿用的项目资料包含失效或已变更的素材，请修正项目资料或关闭本次沿用后重试。");
}
export function formatStudioProjectContextFacts(snapshot: StudioProjectContextSnapshot) {
  return [["目标", snapshot.facts.goal], ["受众", snapshot.facts.audience], ["已确认文案", snapshot.facts.approvedCopy],
    ["视觉要求", snapshot.facts.visualRequirements]].filter(([, value]) => !!value).map(([name, value]) => `${name}：${value}`).join("\n");
}
