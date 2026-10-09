import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { prisma, type Prisma } from "@brandai/db";
import { BrandRule, EDITOR_DOCUMENT_MAX_DECODED_BYTES, EDITOR_DOCUMENT_PREFIX, StudioWorkflowTarget, WatermarkOverlayInput } from "@brandai/contracts";
import { ApiException } from "./api";
import { workflowAssets } from "./studio-workflow-codec";
import { listStudioProjectMaterials } from "./studio-project-materials";
import { StudioExactSnapshot, studioExactIntent } from "./studio-generation-exact";
import { readStudioCleanBase, type StudioCleanBase } from "./studio-generation-base";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes } from "./studio-generation-artifacts-image";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const dimension = z.number().int().positive().max(16384);
export const StudioEditSourceSnapshot = z.object({
  assetId: id, sha256: sha, width: dimension, height: dimension,
  shapeId: StudioWorkflowTarget.shape.shapeId,
  versionId: id.optional(), outputId: id.optional(), sourceGenerationId: id.optional(), recipeHash: sha,
}).strict().superRefine((value, context) => {
  if ([value.versionId, value.outputId, value.sourceGenerationId].filter(Boolean).length % 3 !== 0) {
    context.addIssue({ code: "custom", message: "Generated sources require the complete version/output/generation identity" });
  }
});
export type StudioEditSourceSnapshot = z.infer<typeof StudioEditSourceSnapshot>;
type Db = Prisma.TransactionClient;
type Postprocess = { exactLayout?: StudioExactSnapshot };
const cleanBaseSchema = z.object({ schemaVersion: z.literal(1), encoding: z.literal("aes-256-gcm-v1"),
  objectKey: z.string().min(1).max(1024), keyRevision: z.string().regex(/^[a-f0-9]{24}$/), sha256: sha,
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), width: dimension, height: dimension, sizeBytes: z.number().int().positive().max(32 * 1024 * 1024) }).strict();
const fail = (message = "修改目标已失效、归属不符或原始配方发生变化，请重新选择图片。") => new ApiException(422, message);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);

const adjustKeys = new Set(["light", "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation", "temperature", "tint", "sharpen", "clarity", "grain", "vignette", "glamour", "bloom"]);
function noEffects(shape: Record<string, unknown>, image: boolean) {
  const props = object(shape.props);
  const meta = object(shape.meta);
  const no = (value: unknown, expected: number) => value === undefined || typeof value === "number" && Number.isFinite(value) && Math.abs(value - expected) <= 1e-6;
  if (!no(shape.rotation, 0) || !no(shape.opacity, 1) || !no(props.opacity, 1) || !no(props.radius, 0)) throw fail("整图修改目前读取完整原文件，请先重置旋转、透明度或圆角效果。");
  if ((props.flipX !== undefined && props.flipX !== false) || (props.flipY !== undefined && props.flipY !== false)) throw fail(image ? "整图修改目前读取完整原文件，请先重置图片翻转。" : "整图修改暂不支持父级容器翻转，请先重置容器翻转。");
  if (meta.agentHiddenUntilFit === true || meta.isUploading === true) throw fail("修改目标或容器尚未完成加载，请等待完成后重新保存画布。");
  for (const value of [shape, props, meta]) {
    if ((value.hidden !== undefined && value.hidden !== false) || (value.isHidden !== undefined && value.isHidden !== false)
      || (value.visible !== undefined && value.visible !== true) || (value.visibility !== undefined && value.visibility !== "visible")) throw fail("整图修改不接受隐藏或可见性状态不明的图层。");
  }
  for (const value of [shape, props]) {
    if (["scale", "scaleX", "scaleY", "skewX", "skewY", "transform", "matrix"].some(key => value[key] !== undefined)) throw fail("整图修改暂不支持额外缩放或倾斜矩阵，请整理图层后重试。");
    if (["clip", "clipPath", "mask", "crop", "clipContent", "clipChildren"].some(key => value[key] !== undefined && value[key] !== false && value[key] !== null)) throw fail("整图修改暂不支持额外蒙版或容器裁剪。");
  }
  if (props.adjust !== undefined && (!props.adjust || typeof props.adjust !== "object" || Array.isArray(props.adjust)
    || Object.entries(object(props.adjust)).some(([key, value]) => !adjustKeys.has(key) || !no(value, 0)))) throw fail("整图修改暂不合并调色或滤镜效果，请先重置图片调整。");
  if (props.cropRegion !== undefined) {
    const crop = object(props.cropRegion);
    if (Object.keys(crop).length !== 4 || Object.keys(crop).some(key => !["x", "y", "w", "h"].includes(key)) || !no(crop.x, 0) || !no(crop.y, 0) || !no(crop.w, 1) || !no(crop.h, 1)
      || [crop.x, crop.y, crop.w, crop.h].some(value => value === undefined)) throw fail("整图修改目前读取完整原文件，请先重置图片裁切。");
  }
}

/** The selected shape is only a pointer to the original file. Until rendered
 * target editing exists, reject effects/clipping rather than edit unseen pixels. */
function wholeImageTarget(store: Record<string, unknown>, shapeId: string, width: number, height: number) {
  const shape = object(store[shapeId]), props = object(shape.props);
  if (shape.id !== shapeId || shape.typeName !== "shape" || shape.type !== "c-image") throw fail();
  noEffects(shape, true);
  if (typeof props.w !== "number" || typeof props.h !== "number" || !Number.isFinite(props.w) || !Number.isFinite(props.h) || props.w <= 0 || props.h <= 0
    || Math.abs((props.w / props.h) / (width / height) - 1) > 1e-4) throw fail("整图修改暂不合并非等比拉伸，请恢复图片原始比例后重试。");
  let current = shape;
  const seen = new Set<string>();
  while (true) {
    if (typeof current.id !== "string" || seen.has(current.id) || seen.size >= 64) throw fail("修改目标的画布层级无效。");
    seen.add(current.id);
    if (typeof current.parentId !== "string" || !current.parentId || typeof current.index !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,255}$/.test(current.index)
      || typeof current.x !== "number" || typeof current.y !== "number" || !Number.isFinite(current.x) || !Number.isFinite(current.y) || Math.abs(current.x) > 1e9 || Math.abs(current.y) > 1e9
      || typeof current.rotation !== "number" || !Number.isFinite(current.rotation)) throw fail("修改目标的父级、坐标或排序数据无效，请重新保存画布。");
    const parent = object(Object.prototype.hasOwnProperty.call(store, current.parentId) ? store[current.parentId] : undefined);
    if (parent.id !== current.parentId) throw fail("修改目标所在的页面或容器不存在，请重新保存画布。");
    if (current.parentId.startsWith("page:")) {
      if (parent.typeName !== "page" || !/^page:[\x21-\x7e]+$/.test(current.parentId)) throw fail("修改目标所在的页面无效。");
      break;
    }
    if (parent.typeName !== "shape" || !["group", "frame"].includes(String(parent.type)) || !parent.props || typeof parent.props !== "object" || Array.isArray(parent.props)) throw fail("修改目标的容器暂不支持，请先移到画布上。");
    noEffects(parent, false);
    if (parent.type === "frame") {
      const frame = object(parent.props);
      if (typeof frame.w !== "number" || typeof frame.h !== "number" || !Number.isFinite(frame.w) || !Number.isFinite(frame.h)
        || frame.w <= 0 || frame.h <= 0) throw fail("修改目标的父级画框尺寸无效。");
    }
    // Captured native frames have no automatic clip path: overflow remains
    // visible. Only explicit clip/mask fields above can reject the target.
    current = parent;
  }
}

async function sourceRecord(db: Db, workspaceId: string, projectId: string, assetId: string, shapeId: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, workspaceId, availableForGeneration: true, deprecatedAt: null,
    projectLinks: { some: { projectId, project: { workspaceId } } }, mimeType: { in: ["image/png", "image/jpeg", "image/webp"] } },
    select: { id: true, workspaceId: true, url: true, storageKey: true, generationVersionId: true, mimeType: true, availableForGeneration: true, deprecatedAt: true } });
  if (!asset || asset.workspaceId !== workspaceId || asset.id !== assetId || !asset.availableForGeneration || asset.deprecatedAt) throw fail();
  const generated = await db.studioGeneratedMaterial.findUnique({ where: { assetId }, select: {
    outputId: true, requestId: true, workspaceId: true, projectId: true, userId: true, status: true, assetId: true, versionId: true,
    sha256: true, width: true, height: true, mimeType: true, objectKey: true,
    version: { select: { id: true, generationId: true, imageUrl: true, params: true, width: true, height: true, generation: { select: { id: true, projectId: true, workspaceId: true } } } },
    output: { select: { id: true, requestId: true, workspaceId: true, projectId: true, params: true } },
    request: { select: { id: true, workspaceId: true, projectId: true, userId: true, generationId: true, status: true } },
  } });
  if (generated || asset.generationVersionId) {
    const row = generated;
    if (!row || row.status !== "SUCCEEDED" || row.workspaceId !== workspaceId || row.projectId !== projectId || row.assetId !== assetId || !row.versionId || !row.version
      || row.version.id !== row.versionId || asset.generationVersionId !== row.versionId || row.version.generationId !== row.request.generationId
      || row.version.generation.id !== row.request.generationId || row.version.generation.workspaceId !== workspaceId || row.version.generation.projectId !== projectId
      || row.request.id !== row.requestId || row.request.workspaceId !== workspaceId || row.request.projectId !== projectId || row.request.userId !== row.userId || row.request.status !== "SUCCEEDED"
      || row.output.id !== row.outputId || row.output.requestId !== row.requestId || row.output.workspaceId !== workspaceId || row.output.projectId !== projectId
      || row.objectKey !== asset.storageKey || row.version.imageUrl !== asset.url || row.mimeType !== asset.mimeType || row.width !== row.version.width || row.height !== row.version.height) throw fail();
    const params = object(row.output.params), processing = object(params.studioPostprocess), publicParams = object(row.version.params);
    const overlays = WatermarkOverlayInput.array().max(32).safeParse(processing.watermarkOverlays);
    const rules = BrandRule.array().safeParse(processing.brandRules);
    if (!overlays.success || !rules.success) throw fail("修改目标的品牌合成记录不完整，不能把已合成图片作为干净底图。");
    const exactLayout = processing.exactLayout === undefined ? undefined : StudioExactSnapshot.parse(processing.exactLayout);
    if (exactLayout) studioExactIntent({ studioExactLayout: exactLayout, assetUsages: exactLayout.assetUsages,
      studioExpectedAssetSha256: Object.fromEntries(exactLayout.layers.map(layer => [layer.assetId, layer.sha256])), targets: [exactLayout.target] });
    const hasExactMarker = [params.assetUsages, publicParams.assetUsages].some(value => Array.isArray(value) && value.some(item => object(item).mode === "EXACT"))
      || Array.isArray(publicParams.appliedExactAssetIds) && publicParams.appliedExactAssetIds.length > 0 || !!publicParams.exactComposition;
    if (hasExactMarker && !exactLayout) throw fail("修改目标缺少严格保留配方，未把主体交给模型重绘。");
    const needsBase = !!exactLayout || overlays.data.some(overlay => overlay.enabled) || !!processing.automaticBrandLogoAssetId
      || Array.isArray(publicParams.appliedWatermarkAssetIds) && publicParams.appliedWatermarkAssetIds.length > 0 || !!publicParams.appliedBrandLogoAssetId
      || Array.isArray(publicParams.watermarkOverlays) && publicParams.watermarkOverlays.some(item => object(item).enabled !== false);
    let cleanBase: StudioCleanBase | null = null;
    if (processing.cleanBase !== undefined) {
      const parsed = cleanBaseSchema.safeParse(processing.cleanBase);
      if (!parsed.success) throw fail("修改目标的受保护底图记录无效。");
      cleanBase = parsed.data;
      if (cleanBase.width !== row.width || cleanBase.height !== row.height) throw fail("修改目标与受保护底图的尺寸不一致。");
    }
    if (needsBase && !cleanBase) throw fail("这张历史图片已有主体或水印合成，但没有可恢复的干净底图，暂不能继续改图。");
    if (exactLayout && (exactLayout.target.width !== row.width || exactLayout.target.height !== row.height)) throw fail("修改目标与严格保留布局的尺寸不一致。");
    const snapshot = StudioEditSourceSnapshot.parse({ assetId, shapeId, sha256: row.sha256, width: row.width, height: row.height,
      versionId: row.versionId, outputId: row.outputId, sourceGenerationId: row.request.generationId,
      recipeHash: hash({ asset, outputId: row.outputId, requestId: row.requestId, versionId: row.versionId, sourceGenerationId: row.request.generationId, processing,
        publicRecipe: { assetUsages: publicParams.assetUsages, watermarkOverlays: publicParams.watermarkOverlays,
          appliedExactAssetIds: publicParams.appliedExactAssetIds, exactComposition: publicParams.exactComposition,
          appliedWatermarkAssetIds: publicParams.appliedWatermarkAssetIds, appliedBrandLogoAssetId: publicParams.appliedBrandLogoAssetId } }) });
    return { snapshot, postprocess: { ...(exactLayout ? { exactLayout } : {}) } as Postprocess, cleanBase, asset };
  }
  const upload = await db.studioMaterialUpload.findUnique({ where: { assetId }, select: { workspaceId: true, projectId: true, assetId: true, sha256: true,
    width: true, height: true, mimeType: true, objectKey: true, taskId: true, task: { select: { workspaceId: true, kind: true, status: true } } } });
  if (!upload || upload.workspaceId !== workspaceId || upload.projectId !== projectId || upload.assetId !== assetId || upload.objectKey !== asset.storageKey || upload.mimeType !== asset.mimeType
    || upload.task.workspaceId !== workspaceId || upload.task.kind !== "STUDIO_UPLOAD" || upload.task.status !== "SUCCEEDED") throw fail();
  const snapshot = StudioEditSourceSnapshot.parse({ assetId, shapeId, sha256: upload.sha256, width: upload.width, height: upload.height,
    recipeHash: hash({ asset, taskId: upload.taskId, sha256: upload.sha256, width: upload.width, height: upload.height, mimeType: upload.mimeType }) });
  return { snapshot, postprocess: null, cleanBase: null, asset };
}

/** Caller holds the project lock and has authorized the current editor. */
export async function resolveStudioEditSource(db: Db, workspaceId: string, projectId: string, rawTarget: unknown, canvas: string) {
  const target = StudioWorkflowTarget.parse(rawTarget);
  const materials = await listStudioProjectMaterials(db, workspaceId, projectId);
  const view = workflowAssets(projectId, canvas, materials);
  if (!view.assets.some(item => item.shapeId === target.shapeId && item.assetSha256 === target.assetSha256 && item.valid)) throw fail();
  const store = JSON.parse(gunzipSync(Buffer.from(canvas.slice(EDITOR_DOCUMENT_PREFIX.length), "base64"), { maxOutputLength: EDITOR_DOCUMENT_MAX_DECODED_BYTES }).toString("utf8")).tldrawSnapshot.document.store as Record<string, unknown>;
  const url = object(object(store[target.shapeId]).props).url;
  const candidates = [...new Set(materials.filter(material => material.url === url && material.sha256 === target.assetSha256).map(material => material.assetId))];
  if (candidates.length !== 1) throw fail("修改目标关联到多个素材，请重新插入目标图片。");
  const source = await sourceRecord(db, workspaceId, projectId, candidates[0]!, target.shapeId);
  if (source.snapshot.sha256 !== target.assetSha256) throw fail();
  wholeImageTarget(store, target.shapeId, source.snapshot.width, source.snapshot.height);
  return { snapshot: source.snapshot, postprocess: source.postprocess };
}

export async function inspectStudioEditSource(db: Db, workspaceId: string, projectId: string, rawSnapshot: StudioEditSourceSnapshot) {
  const snapshot = StudioEditSourceSnapshot.parse(rawSnapshot), source = await sourceRecord(db, workspaceId, projectId, snapshot.assetId, snapshot.shapeId);
  if (!equal(source.snapshot, snapshot)) throw fail();
  return { snapshot: source.snapshot, postprocess: source.postprocess };
}

export async function loadStudioEditSource(workspaceId: string, projectId: string, rawSnapshot: StudioEditSourceSnapshot, signal: AbortSignal) {
  signal.throwIfAborted();
  const snapshot = StudioEditSourceSnapshot.parse(rawSnapshot);
  const source = await artifactDeadline(sourceRecord(prisma, workspaceId, projectId, snapshot.assetId, snapshot.shapeId), signal);
  if (!equal(source.snapshot, snapshot)) throw fail();
  const key = source.asset.storageKey;
  if (key && ((!key.startsWith(`${workspaceId}/`) && !key.startsWith(`generations/${workspaceId}/`)) || /[\\?#%]/.test(key) || key.split("/").some(part => !part || part === "." || part === ".."))) throw fail("修改目标的存储归属不正确。");
  const target = await readArtifactImageBytes({ imageUrl: source.asset.url, objectKey: key || null }, signal);
  const targetMeta = await inspectArtifactImage(target, signal);
  if (targetMeta.sha256 !== snapshot.sha256 || targetMeta.width !== snapshot.width || targetMeta.height !== snapshot.height || targetMeta.mimeType !== source.asset.mimeType) throw fail("修改目标的实际图片内容发生变化，未调用改图服务。");
  const body = source.cleanBase ? await readStudioCleanBase(source.cleanBase, { workspaceId, projectId, outputId: snapshot.outputId! }, signal) : target;
  const actual = await inspectArtifactImage(body, signal);
  signal.throwIfAborted();
  return { imageUrl: `data:${actual.mimeType};base64,${body.toString("base64")}`, ...actual, postprocess: source.postprocess };
}

/** The first model input may correctly use the clean base while a secondary
 * reference accidentally reintroduces its flattened EXACT subject. Match bytes
 * as well as asset identity so another authorized copy cannot bypass the guard. */
export function assertStudioEditNotModelReference(
  snapshot: StudioEditSourceSnapshot,
  exactLayout: StudioExactSnapshot | null | undefined,
  audit: Array<Record<string, unknown>>,
) {
  if (exactLayout && audit.some(item => item.assetId === snapshot.assetId || item.sha256 === snapshot.sha256)) {
    throw fail("修改目标含严格保留主体，不能同时把目标成图或相同图片设为模型参考；请取消该参考后重试。");
  }
}

/** Root must call inside the final publish transaction, after its project lock.
 * Legacy disable/remove routes do not take that lock, so lock their actual rows. */
export async function lockStudioEditPublicationSource(db: Db, workspaceId: string, projectId: string, rawSnapshot: StudioEditSourceSnapshot) {
  const snapshot = StudioEditSourceSnapshot.parse(rawSnapshot);
  const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT a."id" FROM "Asset" a JOIN "ProjectAsset" p ON p."assetId" = a."id"
    WHERE a."id" = ${snapshot.assetId} AND a."workspaceId" = ${workspaceId} AND p."projectId" = ${projectId}
      AND a."availableForGeneration" = true AND a."deprecatedAt" IS NULL FOR SHARE OF a, p`;
  if (!rows.length) throw fail("修改目标在生成期间被停用或移出项目，结果暂未发布。");
  if (snapshot.versionId) {
    const source = await db.$queryRaw<Array<{ id: string }>>`SELECT v."id" FROM "GenerationVersion" v
      JOIN "Generation" g ON g."id" = v."generationId" JOIN "StudioGeneratedMaterial" m ON m."versionId" = v."id"
      JOIN "StudioGenerationOutput" o ON o."id" = m."outputId" JOIN "StudioGenerationRequest" r ON r."id" = o."requestId"
      WHERE v."id" = ${snapshot.versionId} AND g."workspaceId" = ${workspaceId} AND g."projectId" = ${projectId}
        AND m."assetId" = ${snapshot.assetId} AND o."id" = ${snapshot.outputId} FOR SHARE OF v, g, m, o, r`;
    if (!source.length) throw fail();
  } else {
    const source = await db.$queryRaw<Array<{ taskId: string }>>`SELECT u."taskId" FROM "StudioMaterialUpload" u JOIN "AsyncTask" t ON t."id" = u."taskId"
      WHERE u."assetId" = ${snapshot.assetId} AND u."workspaceId" = ${workspaceId} AND u."projectId" = ${projectId}
        AND t."status" = 'SUCCEEDED' AND t."kind" = 'STUDIO_UPLOAD' FOR SHARE OF u, t`;
    if (!source.length) throw fail();
  }
  await inspectStudioEditSource(db, workspaceId, projectId, snapshot);
}
