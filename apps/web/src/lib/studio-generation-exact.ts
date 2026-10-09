import { z } from "zod";
import { prisma, type Prisma } from "@brandai/db";
import { AssetUsageInput, ExactAssetTransform, StudioWorkflowTarget } from "@brandai/contracts";
import { ApiException } from "./api";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes, STUDIO_ARTIFACT_MAX_BYTES } from "./studio-generation-artifacts-image";
import { requireStudioBaseEncryption } from "./studio-generation-base";
import { assertStudioExactRasterBudget } from "./studio-exact-geometry";

const dimension = z.number().int().positive().max(16384);
const matrix = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const StudioExactSnapshot = z.object({
  target: z.object({ width: dimension, height: dimension }).strict(),
  frame: z.object({ shapeId: StudioWorkflowTarget.shape.shapeId, width: z.number().positive().finite(), height: z.number().positive().finite(), pageId: z.string().regex(/^page:[\x21-\x7e]+$/), pageTransform: matrix }).strict(),
  layers: z.array(z.object({ shapeId: StudioWorkflowTarget.shape.shapeId, assetId: id, sha256: sha, width: dimension, height: dimension,
    displayWidth: z.number().positive().finite(), displayHeight: z.number().positive().finite(), relativeTransform: matrix, transform: ExactAssetTransform }).strict()).min(1).max(8),
  assetUsages: z.array(AssetUsageInput).min(1).max(8),
}).strict();
export type StudioExactSnapshot = z.infer<typeof StudioExactSnapshot>;
type AcceptedJob = { studioExactLayout?: unknown; studioExpectedAssetSha256?: Record<string, string>; assetUsages?: AssetUsageInput[]; targets?: {width:number;height:number}[] };

/** This reads server-owned jobData, not client geometry. All redundant mirrors
 * must agree so a missing snapshot cannot downgrade identity preservation. */
export function studioExactIntent(job: AcceptedJob) {
  const exact = (job.assetUsages ?? []).filter(item => item.mode === "EXACT");
  const fail = () => new ApiException(422, "严格保留素材的受理快照不完整，请重新选择画框后提交。");
  if (!exact.length) {
    if (job.studioExactLayout !== undefined) throw fail();
    return { layout: null, modelExpected: job.studioExpectedAssetSha256 ?? {} };
  }
  const parsed = StudioExactSnapshot.safeParse(job.studioExactLayout);
  if (!parsed.success) throw fail();
  const layout = parsed.data, expected = job.studioExpectedAssetSha256 ?? {};
  if (layout.layers.length !== exact.length || layout.assetUsages.length !== exact.length || new Set(layout.layers.map(x => x.assetId)).size !== exact.length
    || job.targets?.length !== 1 || job.targets[0]!.width !== layout.target.width || job.targets[0]!.height !== layout.target.height) throw fail();
  for (const layer of layout.layers) {
    const usage = exact.find(item => item.assetId === layer.assetId), mirror = layout.assetUsages.find(item => item.assetId === layer.assetId);
    if (!usage || mirror?.mode !== "EXACT" || usage.order !== mirror.order || expected[layer.assetId] !== layer.sha256
      || JSON.stringify(ExactAssetTransform.parse(usage.exactTransform)) !== JSON.stringify(layer.transform)
      || JSON.stringify(ExactAssetTransform.parse(mirror.exactTransform)) !== JSON.stringify(layer.transform)) throw fail();
  }
  const exactIds = new Set(exact.map(item => item.assetId));
  return { layout, modelExpected: Object.fromEntries(Object.entries(expected).filter(([assetId]) => !exactIds.has(assetId))) };
}

export async function loadStudioExactAsset(workspaceId: string, projectId: string, assetId: string) {
  const asset = await prisma.asset.findFirst({ where: { id: assetId, workspaceId, availableForGeneration: true, deprecatedAt: null,
    mimeType: { in: ["image/png", "image/jpeg", "image/webp"] }, projectLinks: { some: { projectId, project: { workspaceId } } } }, select: { url: true, storageKey: true } });
  if (!asset) throw new ApiException(422, "严格保留素材已删除、停用或不属于当前项目。");
  const objectKey = asset.storageKey || null;
  if (objectKey && (!objectKey.startsWith(`${workspaceId}/`) && !objectKey.startsWith(`generations/${workspaceId}/`)
    || /[\\?#%]/.test(objectKey) || objectKey.split("/").some(p => !p || p === "." || p === ".."))) throw new ApiException(422, "严格保留素材的存储归属不正确。");
  return { imageUrl: asset.url, objectKey };
}

export async function preflightStudioExactSources(workspaceId: string, projectId: string, layout: StudioExactSnapshot | null, signal: AbortSignal) {
  if (!layout) return;
  assertStudioExactRasterBudget(layout.target, layout.layers);
  requireStudioBaseEncryption();
  let bytes = 0;
  for (const layer of layout.layers) {
    const source = await artifactDeadline(loadStudioExactAsset(workspaceId, projectId, layer.assetId), signal);
    const body = await readArtifactImageBytes(source, signal); bytes += body.length;
    if (bytes > STUDIO_ARTIFACT_MAX_BYTES) throw new ApiException(422, "严格保留素材合计超过32MB，请减少素材。");
    const actual = await inspectArtifactImage(body, signal);
    if (actual.sha256 !== layer.sha256 || actual.width !== layer.width || actual.height !== layer.height) throw new ApiException(422, "严格保留原素材已发生变化，未调用生成服务，请重新选择。");
  }
}

/** Lock the actual source and membership rows through publication. Legacy
 * library disable/delete paths do not take the Project lock. A plain re-read
 * would still permit a source to disappear between the check and commit. */
export async function lockStudioExactPublicationSources(db: Prisma.TransactionClient, workspaceId: string, projectId: string, layout: StudioExactSnapshot) {
  for (const layer of [...layout.layers].sort((a,b) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0)) {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT a."id" FROM "Asset" a JOIN "ProjectAsset" p ON p."assetId" = a."id"
      WHERE a."id" = ${layer.assetId} AND a."workspaceId" = ${workspaceId}
        AND p."projectId" = ${projectId} AND a."availableForGeneration" = true AND a."deprecatedAt" IS NULL
      FOR SHARE OF a, p`;
    if (!rows.length) throw new ApiException(422, "严格保留素材在保存期间被停用或移出项目，原始生成结果仍保留，未发布图片。");
  }
}

/** An EXACT source can also be pulled in by brand rules or examples. Never
 * silently send those pixels through that second route or omit brand policy. */
export function assertStudioExactNotModelInput(layout: StudioExactSnapshot | null, audit: Array<Record<string, unknown>>) {
  if (layout && audit.some(item => layout.layers.some(layer => layer.assetId === item.assetId || layer.sha256 === item.sha256))) {
    throw new ApiException(422, "严格保留素材同时被设置为模型参考或品牌示例，请调整重复用途后重试；原图未交给模型重绘。");
  }
}
