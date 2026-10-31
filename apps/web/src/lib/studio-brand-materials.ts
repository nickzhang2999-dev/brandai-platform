import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@brandai/db";
import { lockTaskWorkspace } from "./workspace-task-lock";
import { STUDIO_MATERIAL_TTL_MS } from "@brandai/contracts";
import { StudioBrandMaterialsQuery, StudioBrandMaterialsPage, StudioBrandMaterialVerification,
  StudioBrandMaterialOperation } from "../../../../packages/contracts/src/studio-brand-materials";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { requireStudioMaterialProject } from "./studio-materials";
import { studioBrandMaterialSourceDigest, studioTrustedMaterial } from "./studio-brand-materials-trust";
import { enqueueStudioBrandMaterial } from "./studio-brand-materials-queue";

export const studioBrandAssetSelect = {
  id: true, workspaceId: true, storageKey: true, url: true, fileName: true,
  mimeType: true, sizeBytes: true, generationVersionId: true, libraryKind: true,
  createdAt: true, availableForGeneration: true, deprecatedAt: true,
  studioBrandMaterialReceipt: { include: { task: true } },
  studioUploads: { where: { task: { status: "SUCCEEDED" } }, take: 1,
    select: { workspaceId: true, assetId: true, sha256: true, mimeType: true, width: true, height: true, objectKey: true,
      task: { select: { workspaceId: true, kind: true, status: true } } } },
  studioGeneratedMaterial: { select: { workspaceId: true, projectId: true, assetId: true, status: true,
    sha256: true, mimeType: true, width: true, height: true, objectKey: true, versionId: true,
    version: { select: { id: true, imageUrl: true, generation: { select: { workspaceId: true, projectId: true } } } },
    request: { select: { workspaceId: true, projectId: true, status: true } },
    output: { select: { workspaceId: true, projectId: true } } } },
} satisfies Prisma.AssetSelect;
type BrandAsset = Prisma.AssetGetPayload<{ select: typeof studioBrandAssetSelect }>;
type Db = Prisma.TransactionClient;

export function trustedStudioBrandAsset(asset: BrandAsset) {
  const receipt = asset.studioBrandMaterialReceipt;
  if (receipt?.task.status === "SUCCEEDED" && receipt.workspaceId === asset.workspaceId && receipt.assetId === asset.id
    && receipt.task.workspaceId === asset.workspaceId && receipt.task.kind === "STUDIO_MATERIAL_VERIFY"
    && receipt.sourceDigest === studioBrandMaterialSourceDigest(asset)) return studioTrustedMaterial(asset, receipt);
  const upload = asset.studioUploads[0];
  if (upload?.workspaceId === asset.workspaceId && upload.assetId === asset.id && upload.objectKey === asset.storageKey
    && upload.task.workspaceId === asset.workspaceId && upload.task.kind === "STUDIO_UPLOAD" && upload.task.status === "SUCCEEDED") {
    const material = studioTrustedMaterial(asset, upload);
    if (material) return material;
  }
  const generated = asset.studioGeneratedMaterial;
  if (generated?.status === "SUCCEEDED" && generated.workspaceId === asset.workspaceId && generated.assetId === asset.id
    && generated.objectKey === asset.storageKey && generated.versionId === asset.generationVersionId
    && generated.version?.id === generated.versionId && generated.version.imageUrl === asset.url
    && generated.version.generation.workspaceId === asset.workspaceId && generated.version.generation.projectId === generated.projectId
    && generated.request.workspaceId === asset.workspaceId && generated.request.projectId === generated.projectId && generated.request.status === "SUCCEEDED"
    && generated.output.workspaceId === asset.workspaceId && generated.output.projectId === generated.projectId) return studioTrustedMaterial(asset, generated);
  return null;
}

const activeAsset = (workspaceId: string) => ({ workspaceId, deprecatedAt: null, availableForGeneration: true,
  mimeType: { in: ["image/png", "image/jpeg", "image/webp"] } });
function cursorParts(cursor: string) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Object.keys(value).sort().join(",") !== "createdAt,id" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)
      || typeof value.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) throw new Error();
    return { id: value.id as string, createdAt: new Date(value.createdAt) };
  } catch { throw new ApiException(422, "素材分页标识无效，请重新打开素材库。"); }
}

/** A real keyset page; never return an unbounded whole brand library. */
export async function listStudioBrandMaterials(workspaceId: string, userId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const query = StudioBrandMaterialsQuery.parse(raw), cursor = query.cursor ? cursorParts(query.cursor) : null;
  const rows = await prisma.asset.findMany({ where: { ...activeAsset(workspaceId),
    ...(query.libraryKind !== "ALL" ? { libraryKind: query.libraryKind } : {}),
    AND: [
      ...(query.search ? [{ OR: [{ fileName: { contains: query.search, mode: "insensitive" as const } },
        { aiDescription: { contains: query.search, mode: "insensitive" as const } }, { tags: { has: query.search } }, { aiTags: { has: query.search } }] }] : []),
      ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] : []),
    ],
  }, select: studioBrandAssetSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1 });
  const page = rows.slice(0, query.limit), last = page.at(-1);
  return StudioBrandMaterialsPage.parse({ items: page.map(asset => ({ assetId: asset.id, fileName: asset.fileName,
    mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, libraryKind: ["MATERIAL", "TEMPLATE", "GENERATED"].includes(asset.libraryKind) ? asset.libraryKind : "MATERIAL",
    createdAt: asset.createdAt.toISOString(), url: `/api/workspaces/${workspaceId}/assets/${asset.id}/raw`,
    ...(trustedStudioBrandAsset(asset) ? { material: trustedStudioBrandAsset(asset) } : {}),
  })), nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString("base64url") : null });
}

async function requireAsset(db: Db, workspaceId: string, assetId: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, ...activeAsset(workspaceId) }, select: studioBrandAssetSelect });
  if (!asset) throw new ApiException(404, "素材不存在、已停用或不属于当前品牌。");
  return asset;
}

/** Internal only. Caller authenticates EDITOR and holds the current Project
 * lock. Raw file identity, never a clean-base recipe, supports explicit tools. */
export async function requireTrustedStudioBrandProjectMaterial(db: Db, workspaceId: string, projectId: string,
  assetId: string, expectedSha256: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, ...activeAsset(workspaceId),
    projectLinks: { some: { projectId, project: { workspaceId, archivedAt: null } } } }, select: studioBrandAssetSelect });
  if (!asset) throw new ApiException(404, "图片不属于当前可编辑品牌与项目。");
  const material = trustedStudioBrandAsset(asset);
  if (!material || material.assetSha256 !== expectedSha256) throw new ApiException(422, "图片尚未校验或内容发生变化，请重新选择。");
  return { ...material, storageKey: asset.storageKey, imageUrl: asset.url,
    generationVersionId: asset.generationVersionId, sourceProjectId: asset.studioGeneratedMaterial?.projectId ?? null };
}
export async function readStudioBrandMaterial(workspaceId: string, userId: string, assetId: string) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  await expireStudioBrandMaterialVerifications(workspaceId);
  const asset = await requireAsset(prisma, workspaceId, assetId), material = trustedStudioBrandAsset(asset), row = asset.studioBrandMaterialReceipt;
  if (material) return StudioBrandMaterialVerification.parse({ assetId, status: "SUCCEEDED", material });
  if (!row || row.sourceDigest !== studioBrandMaterialSourceDigest(asset)) return StudioBrandMaterialVerification.parse({ assetId, status: "UNVERIFIED" });
  const status = row.task.status === "SUCCEEDED" ? "FAILED" : row.task.status;
  return StudioBrandMaterialVerification.parse({ assetId, taskId: row.taskId, status,
    ...(status === "FAILED" ? { error: row.task.error ?? "素材校验记录无效，请重新验证。" } : {}) });
}

export async function mutateStudioBrandMaterial(workspaceId: string, userId: string, assetId: string, raw: unknown) {
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const input = StudioBrandMaterialOperation.parse(raw);
  if (input.operation === "verify") return verifyStudioBrandMaterial(workspaceId, userId, assetId);
  await requireStudioMaterialProject(workspaceId, userId, input.projectId, true);
  return prisma.$transaction(async tx => {
    await lockTaskWorkspace(tx, workspaceId);
    const projects = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>`SELECT "archivedAt" FROM "Project" WHERE "id" = ${input.projectId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (!projects[0] || projects[0].archivedAt) throw new ApiException(409, "项目不存在或已归档，未添加素材。");
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Asset" WHERE "id" = ${assetId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    if (!locked[0]) throw new ApiException(404, "素材不存在。");
    const asset = await requireAsset(tx, workspaceId, assetId), material = trustedStudioBrandAsset(asset);
    if (!material) throw new ApiException(409, "这张图片尚未完成校验，请先验证素材。");
    if (material.assetSha256 !== input.assetSha256) throw new ApiException(422, "素材内容已变化，未添加其他图片。请刷新素材库。");
    await tx.projectAsset.upsert({ where: { projectId_assetId_kind: { projectId: input.projectId, assetId, kind: "MEMBER" } },
      create: { projectId: input.projectId, assetId, kind: "MEMBER", usageMode: "REFERENCE" }, update: {} });
    return material;
  }, { timeout: 10_000 });
}

async function verifyStudioBrandMaterial(workspaceId: string, userId: string, assetId: string) {
  await expireStudioBrandMaterialVerifications(workspaceId);
  const result = await prisma.$transaction(async tx => {
    await lockTaskWorkspace(tx, workspaceId);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(20261014, 3)::text`;
    const asset = await requireAsset(tx, workspaceId, assetId), material = trustedStudioBrandAsset(asset);
    if (material) return { material };
    const digest = studioBrandMaterialSourceDigest(asset), current = asset.studioBrandMaterialReceipt;
    if (current && current.sourceDigest === digest && ["PENDING", "RUNNING"].includes(current.task.status)) return { taskId: current.taskId };
    const pending = await tx.studioBrandMaterialReceipt.count({ where: { task: { status: { in: ["PENDING", "RUNNING"] } } } });
    const local = await tx.studioBrandMaterialReceipt.count({ where: { workspaceId, task: { status: { in: ["PENDING", "RUNNING"] } } } });
    if (pending >= 200 || local >= 30) throw new ApiException(429, "待校验图片较多，请稍后重试。");
    const taskId = "sbmv_" + randomUUID().replace(/-/g, "");
    await tx.asyncTask.create({ data: { id: taskId, workspaceId, kind: "STUDIO_MATERIAL_VERIFY", jobId: taskId } });
    const data = { workspaceId, userId, taskId, sourceDigest: digest, sha256: null, width: null, height: null,
      mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, attemptToken: null, expiresAt: new Date(Date.now() + STUDIO_MATERIAL_TTL_MS) };
    await tx.studioBrandMaterialReceipt.upsert({ where: { assetId }, create: { assetId, ...data }, update: data });
    return { taskId };
  }, { timeout: 10_000 });
  if (result.taskId) await enqueueStudioBrandMaterial(result.taskId);
  return result.material ? StudioBrandMaterialVerification.parse({ assetId, status: "SUCCEEDED", material: result.material })
    : readStudioBrandMaterial(workspaceId, userId, assetId);
}

export async function expireStudioBrandMaterialVerifications(workspaceId?: string) {
  await prisma.asyncTask.updateMany({ where: { kind: "STUDIO_MATERIAL_VERIFY", status: { in: ["PENDING", "RUNNING"] },
    studioBrandMaterialReceipt: { ...(workspaceId ? { workspaceId } : {}), expiresAt: { lte: new Date() } } },
    data: { status: "FAILED", error: "素材校验超时，请重新验证；原图片仍在品牌素材库。" } });
}
