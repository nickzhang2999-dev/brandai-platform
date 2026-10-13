import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, Prisma } from "@brandai/db";
import { DecomposeResponse } from "@brandai/contracts";
import { StudioDecompositionInput, StudioDecompositionQuery, StudioDecompositionView, StudioDecompositionLayer,
  STUDIO_DECOMPOSITION_TTL_MS, STUDIO_LAYER_RECOVERY_TTL_MS } from "../../../../packages/contracts/src/studio-decomposition";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { readEditorDocument } from "./editor-documents";
import { decodeOwnedCanvas } from "./owned-canvas-codec";
import { requireOwnedLayerSource } from "./owned-canvas-decomposition";
import { getEffectiveAiSettings, getEffectiveStorage } from "./settings";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes } from "./studio-generation-artifacts-image";
import { encryptStudioBase, decryptStudioBase, requireStudioBaseEncryption } from "./studio-generation-base";
import { getObjectStream, uploadBuffer, deleteObject } from "./s3";
import { nodeStreamToBuffer } from "./image-preview";
import { assertStudioLayerBudget, inspectStudioLayer } from "./studio-decomposition-images";
import { enqueueStudioDecomposition } from "./studio-decomposition-queue";
import { ai } from "./ai";
import { recordUsage } from "./usage";
import { generatedPsdLayerCount, generatedPsdMutationId, generatedPsdSourceShapeId } from "./studio-generated-psd-state";
import { assertStudioPsdBudget, StudioPsdEncodingError } from "./studio-psd-codec";

type Row = Prisma.StudioDecompositionRequestGetPayload<object>;
type Layer = z.infer<typeof StudioDecompositionLayer>;
const PrivateOutput = z.object({ result: DecomposeResponse, publishedLayers: z.array(StudioDecompositionLayer).nullable() }).strict();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keysOf = (row: Pick<Row, "objectKeys">) => z.array(z.string().max(512)).max(30).parse(row.objectKeys);
const outputOf = (row: Row) => row.outputJson === null ? null : PrivateOutput.parse(row.outputJson);
const receiptSelect = { id: true, mutationId: true, projectId: true, workspaceId: true, sourceShapeId: true, assetId: true, assetSha256: true,
  documentRevision: true, layerCount: true, sourceWidth: true, sourceHeight: true, status: true, error: true,
  createdAt: true, expiresAt: true, archiveExpiresAt: true, archiveToken: true, objectKeys: true, publishedLayers: true } satisfies Prisma.StudioDecompositionRequestSelect;
type ReceiptRow = Prisma.StudioDecompositionRequestGetPayload<{ select: typeof receiptSelect }>;
const identity = (workspaceId: string, userId: string, input: z.infer<typeof StudioDecompositionInput>) => ({ workspaceId, userId, projectId: input.projectId, mutationId: input.mutationId });

async function projectAccess(workspaceId: string, userId: string, projectId: string, write = false) {
  await requireWorkspaceRole(workspaceId, userId, write ? "EDITOR" : "VIEWER");
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true, archivedAt: true } });
  if (!project) throw new ApiException(404, "项目不存在。");
  if (write && project.archivedAt) throw new ApiException(409, "项目已归档，请先恢复后再操作。");
  return project;
}
async function actorInTransaction(tx: Prisma.TransactionClient, row: Pick<Row, "workspaceId" | "userId" | "projectId">) {
  const [workspace, user, project] = await Promise.all([
    tx.brandWorkspace.findUnique({ where: { id: row.workspaceId }, select: { ownerId: true } }),
    tx.user.findUnique({ where: { id: row.userId }, select: { isActive: true } }),
    tx.project.findFirst({ where: { id: row.projectId, workspaceId: row.workspaceId }, select: { archivedAt: true } }),
  ]);
  if (!workspace || !user?.isActive || !project || project.archivedAt) throw new ApiException(409, "账号或项目已不可编辑，原图片仍保留。");
  if (workspace.ownerId !== row.userId) {
    const member = await tx.membership.findUnique({ where: { userId_workspaceId: { userId: row.userId, workspaceId: row.workspaceId } }, select: { role: true } });
    if (!member || !["OWNER", "EDITOR"].includes(member.role)) throw new ApiException(403, "品牌编辑权限已变化，任务已停止。");
  }
}
async function configured() {
  const [settings, storage] = await Promise.all([getEffectiveAiSettings(), getEffectiveStorage()]);
  if (settings.layer.provider?.trim().toLowerCase() !== "fal" || !settings.layer.apiKey?.trim()) throw new ApiException(503, "真实 AI 分层服务尚未配置，请联系管理员配置图层分解服务。");
  if (!storage.configured) throw new ApiException(503, "图片存储尚未配置，暂不能保存图层。");
  requireStudioBaseEncryption();
}
function canRetry(row: Pick<Row, "status" | "archiveExpiresAt" | "objectKeys" | "archiveToken">) {
  return row.status === "FAILED" && row.archiveExpiresAt !== null
    && row.archiveExpiresAt.getTime() > Date.now() && keysOf(row).length < 30 && row.archiveToken === null;
}
function receipt(row: ReceiptRow) {
  return StudioDecompositionView.parse({ requestId: row.id, mutationId: row.mutationId, projectId: row.projectId,
    sourceShapeId: row.sourceShapeId, assetId: row.assetId, assetSha256: row.assetSha256,
    documentRevision: row.documentRevision, layerCount: row.layerCount, sourceWidth: row.sourceWidth, sourceHeight: row.sourceHeight,
    status: row.status, error: row.error, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    archiveExpiresAt: row.archiveExpiresAt?.toISOString() ?? null, canRetryArchive: canRetry(row),
    layers: row.status === "SUCCEEDED" ? z.array(StudioDecompositionLayer).parse(row.publishedLayers) : [] });
}

/** Only new-product assets with a verified durable archive can become inputs.
 * Legacy remote assets and previously split layers need a separate policy. */
async function sourceAsset(workspaceId: string, projectId: string, assetId: string, expectedHash: string) {
  const asset = await prisma.asset.findFirst({ where: { id: assetId, workspaceId, deprecatedAt: null,
    projectLinks: { some: { projectId, project: { workspaceId } } } } });
  if (!asset) throw new ApiException(404, "原图片不属于当前品牌与项目。");
  const [upload, generated] = await Promise.all([
    prisma.studioMaterialUpload.findFirst({ where: { workspaceId, projectId, assetId, sha256: expectedHash, task: { status: "SUCCEEDED" } } }),
    prisma.studioGeneratedMaterial.findFirst({ where: { workspaceId, projectId, assetId, sha256: expectedHash, status: "SUCCEEDED" }, include: { request: { select: { jobData: true } } } }),
  ]);
  const row = upload ?? generated;
  if (!row || !row.width || !row.height || !row.mimeType || !row.sizeBytes || !["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)
    || !asset.storageKey || asset.storageKey !== row.objectKey || row.sizeBytes !== asset.sizeBytes || asset.mimeType !== row.mimeType) throw new ApiException(422, "原图片的存储校验记录不完整，暂不能分层。");
  if (generated) {
    const job = generated.request.jobData as Record<string, unknown>;
    const usages = Array.isArray(job.assetUsages) ? job.assetUsages : [];
    if (job.studioExactLayout !== undefined || usages.some(value => value && typeof value === "object" && (value as Record<string, unknown>).mode === "EXACT")) throw new ApiException(409, "这张图片包含严格保留素材。分层模型可能重画主体，当前先保留原图保护。");
  }
  if (!row.objectKey.startsWith(workspaceId + "/") || /[\\?#%]/.test(row.objectKey) || row.objectKey.split("/").some(part => !part || part === "." || part === "..")) throw new ApiException(422, "原图片存储位置不属于当前品牌。");
  return { sourceWidth: row.width, sourceHeight: row.height, sourceMimeType: row.mimeType, sourceSizeBytes: row.sizeBytes, sourceObjectKey: row.objectKey };
}

export async function expireStudioDecompositions(workspaceId?: string) {
  await prisma.studioDecompositionRequest.updateMany({ where: { ...(workspaceId ? { workspaceId } : {}), status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } },
    data: { status: "FAILED", error: "分层任务超过处理期限。已有结果可重新保存；未确认模型结果时不会自动再次调用。", archiveToken: null, archivingStartedAt: null } });
}
export async function readStudioDecompositions(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioDecompositionQuery.parse(raw); await projectAccess(workspaceId, userId, input.projectId);
  await expireStudioDecompositions(workspaceId);
  const rows = await prisma.studioDecompositionRequest.findMany({ where: { workspaceId, projectId: input.projectId, ...(input.requestId ? { id: input.requestId } : {}) }, select: receiptSelect, orderBy: { createdAt: "desc" }, take: input.requestId ? 1 : 50 });
  if (input.requestId) { if (!rows[0]) throw new ApiException(404, "分层任务不存在。"); return receipt(rows[0]); }
  return { requests: rows.map(receipt) };
}
export async function submitStudioDecomposition(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioDecompositionInput.parse(raw), scope = identity(workspaceId, userId, input), payloadHash = hash(input);
  await projectAccess(workspaceId, userId, input.projectId, true);
  const existing = await prisma.studioDecompositionRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: scope } });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new ApiException(409, "同一次分层请求不能改成其他图片或层数。");
    await expireStudioDecompositions(workspaceId);
    const current = await prisma.studioDecompositionRequest.findUniqueOrThrow({ where: { id: existing.id } });
    if (current.status === "PENDING" && !current.providerStartedAt) await enqueueStudioDecomposition(current.id);
    return receipt(current);
  }
  await configured();
  const document = await readEditorDocument(workspaceId, input.projectId, userId);
  if (document.readOnly || document.revision !== input.documentRevision) throw new ApiException(409, "画布已变化或只读，请先保存再重新选择图片。");
  try { requireOwnedLayerSource(await decodeOwnedCanvas(document.canvas), input); }
  catch (error) { throw new ApiException(422, error instanceof Error ? error.message : "原图片无法确认。"); }
  const source = await sourceAsset(workspaceId, input.projectId, input.assetId, input.assetSha256);
  assertStudioLayerBudget(source.sourceWidth, source.sourceHeight, input.layerCount);
  await expireStudioDecompositions(workspaceId);
  const row = await prisma.$transaction(async tx => {
    // A separate intake lane bounds model queue/claim memory without changing
    // the existing upload/generation lock defaults.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(20261012, 3)::text`;
    const duplicate = await tx.studioDecompositionRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: scope } });
    if (duplicate) { if (duplicate.payloadHash !== payloadHash) throw new ApiException(409, "分层请求标识已被其他内容使用。"); return duplicate; }
    const [local, global] = await Promise.all([
      tx.studioDecompositionRequest.count({ where: { workspaceId, status: { in: ["PENDING", "RUNNING"] } } }),
      tx.studioDecompositionRequest.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
    ]);
    if (local >= 10 || global >= 100) throw new ApiException(429, "正在处理的分层任务较多，请稍后再试。");
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${input.projectId} AND "workspaceId"=${workspaceId} FOR UPDATE`;
    await actorInTransaction(tx, scope);
    const saved = await tx.editorDocument.findUnique({ where: { projectId: input.projectId }, select: { workspaceId: true, revision: true, checksum: true } });
    if (!saved || saved.workspaceId !== workspaceId || saved.revision !== input.documentRevision || saved.checksum !== document.checksum) throw new ApiException(409, "画布刚刚被更新，请保存后重试。");
    return tx.studioDecompositionRequest.create({ data: { ...scope, ...source, payloadHash,
      sourceShapeId: input.sourceShapeId, assetId: input.assetId, assetSha256: input.assetSha256, documentRevision: input.documentRevision,
      layerCount: input.layerCount, intent: input.intent ?? null, expiresAt: new Date(Date.now() + STUDIO_DECOMPOSITION_TTL_MS) } });
  }, { timeout: 10_000 });
  await enqueueStudioDecomposition(row.id); return receipt(row);
}

/** Internal-only continuation of an accepted generation. The original image
 * must have completed its real byte archive; no client URL/asset/geometry or
 * current canvas selection is trusted. Missing model configuration is a
 * separate durable worker failure and never rolls back the original image. */
export async function submitGeneratedStudioDecomposition(generationRequestId: string) {
  const generation = await prisma.studioGenerationRequest.findUnique({ where: { id: generationRequestId } });
  if (!generation || generation.status !== "SUCCEEDED") throw new ApiException(409, "原图片尚未完成生成，暂不能准备 PSD。");
  const layerCount = generatedPsdLayerCount(generation.jobData);
  if (layerCount === null) throw new ApiException(409, "该次生成没有选择可编辑 PSD。");
  const { workspaceId, userId, projectId } = generation;
  await projectAccess(workspaceId, userId, projectId, true);
  const scope = { workspaceId, userId, projectId, mutationId: generatedPsdMutationId(generation.id, generation.mutationId) };
  const existing = await prisma.studioDecompositionRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: scope } });
  if (existing) {
    if (existing.layerCount !== layerCount) throw new ApiException(409, "自动 PSD 的受理层数已变化，未提交新模型任务。");
    return receipt(existing);
  }
  const material = await prisma.studioGeneratedMaterial.findFirst({ where: { requestId: generation.id, workspaceId, userId, projectId, status: "SUCCEEDED" }, orderBy: { createdAt: "asc" } });
  if (!material?.assetId || !material.sha256) throw new ApiException(409, "原图片尚未完成持久化，请等待保存结果。");
  const source = await sourceAsset(workspaceId, projectId, material.assetId, material.sha256);
  assertStudioLayerBudget(source.sourceWidth, source.sourceHeight, layerCount);
  try { assertStudioPsdBudget(source.sourceWidth, source.sourceHeight, layerCount); }
  catch (error) { if (error instanceof StudioPsdEncodingError) throw new ApiException(422, "这张图片的尺寸与层数超过 PSD 导出内存预算，未调用分层模型。请选择更少图层或更小尺寸。"); throw error; }
  const input = StudioDecompositionInput.parse({ projectId, mutationId: scope.mutationId,
    sourceShapeId: generatedPsdSourceShapeId(material.assetId), assetId: material.assetId,
    assetSha256: material.sha256, documentRevision: generation.documentRevision, layerCount });
  await expireStudioDecompositions(workspaceId);
  const row = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(20261012, 3)::text`;
    const duplicate = await tx.studioDecompositionRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: scope } });
    if (duplicate) { if (duplicate.payloadHash !== hash(input)) throw new ApiException(409, "自动 PSD 请求来源已变化。"); return duplicate; }
    const [local, global] = await Promise.all([
      tx.studioDecompositionRequest.count({ where: { workspaceId, status: { in: ["PENDING", "RUNNING"] } } }),
      tx.studioDecompositionRequest.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
    ]);
    if (local >= 10 || global >= 100) throw new ApiException(429, "分层任务队列繁忙，原图片可继续使用。");
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${projectId} AND "workspaceId"=${workspaceId} FOR UPDATE`;
    await actorInTransaction(tx, scope);
    const [current, asset] = await Promise.all([
      tx.studioGeneratedMaterial.findUnique({ where: { outputId: material.outputId } }),
      tx.asset.findFirst({ where: { id: material.assetId!, workspaceId, deprecatedAt: null,
        projectLinks: { some: { projectId, project: { workspaceId } } } } }),
    ]);
    if (!current || current.requestId !== generation.id || current.workspaceId !== workspaceId || current.projectId !== projectId || current.userId !== userId || current.status !== "SUCCEEDED"
      || current.assetId !== material.assetId || current.sha256 !== material.sha256 || current.objectKey !== source.sourceObjectKey
      || !asset || asset.storageKey !== source.sourceObjectKey || asset.sizeBytes !== source.sourceSizeBytes || asset.mimeType !== source.sourceMimeType) throw new ApiException(409, "原图片存储或归属已变化，未提交分层模型。");
    return tx.studioDecompositionRequest.create({ data: { ...scope, ...source, payloadHash: hash(input),
      sourceShapeId: input.sourceShapeId, assetId: input.assetId, assetSha256: input.assetSha256,
      documentRevision: input.documentRevision, layerCount, intent: null,
      expiresAt: new Date(Date.now() + STUDIO_DECOMPOSITION_TTL_MS) } });
  }, { timeout: 10_000 });
  // The DB row is the outbox. Redis delivery failure must not create a new
  // mutation/provider claim or make a completed image fail.
  await enqueueStudioDecomposition(row.id).catch(() => false);
  return receipt(row);
}

export async function retryStudioLayerArchive(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioDecompositionQuery.extend({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).parse(raw);
  await projectAccess(workspaceId, userId, input.projectId, true); await expireStudioDecompositions(workspaceId);
  const row = await prisma.studioDecompositionRequest.findFirst({ where: { id: input.requestId, workspaceId, projectId: input.projectId } });
  if (!row) throw new ApiException(404, "分层任务不存在。");
  if (row.status === "SUCCEEDED") return receipt(row);
  if (!canRetry(row) || !row.outputJson) throw new ApiException(409, "没有可重存的模型结果。请核对任务状态；不会重新调用模型。");
  const output = outputOf(row);
  if (!output || keysOf(row).length + output.result.layers.length > 30) throw new ApiException(409, "图层保存重试次数已达到上限，请联系管理员检查存储。");
  const changed = await prisma.studioDecompositionRequest.updateMany({ where: { id: row.id, status: "FAILED", archiveToken: null, archiveExpiresAt: { gt: new Date() } },
    data: { status: "RUNNING", expiresAt: new Date(Math.min(Date.now() + STUDIO_DECOMPOSITION_TTL_MS, row.archiveExpiresAt!.getTime())), error: null } });
  if (changed.count) await enqueueStudioDecomposition(row.id);
  return receipt(await prisma.studioDecompositionRequest.findUniqueOrThrow({ where: { id: row.id } }));
}

/** Claim once in Postgres. Redis retries and lost HTTP receipts cannot re-enter
 * the paid call. Archive-only retries always use the private provider output. */
export async function runStudioDecomposition(requestId: string) {
  let row = await prisma.studioDecompositionRequest.findUnique({ where: { id: requestId } });
  if (!row || !["PENDING", "RUNNING"].includes(row.status) || row.expiresAt.getTime() <= Date.now()) return;
  // Another delivery owns the ambiguous paid call; only its deadline/saved
  // output can progress it. Do not call or fail that owner's in-flight request.
  if (row.providerStartedAt && !row.outputJson) return;
  const originalDeadline = row.expiresAt;
  const signal = AbortSignal.timeout(Math.max(1, originalDeadline.getTime() - Date.now()));
  let ownedProviderClaim: Date | null = null;
  try {
    if (!row.providerStartedAt) {
      await configured(); await projectAccess(row.workspaceId, row.userId, row.projectId, true);
      const original = await artifactDeadline(readArtifactImageBytes({ imageUrl: "", objectKey: row.sourceObjectKey }, signal), signal);
      const metadata = await inspectArtifactImage(original, signal);
      if (metadata.sha256 !== row.assetSha256 || metadata.width !== row.sourceWidth || metadata.height !== row.sourceHeight || metadata.sizeBytes !== row.sourceSizeBytes || metadata.mimeType !== row.sourceMimeType) throw new ApiException(422, "原图片的实际内容与受理记录不一致，未提交模型。");
      const claimTime = new Date();
      const claimed = await prisma.$transaction(async tx => {
        await actorInTransaction(tx, row!);
        return tx.studioDecompositionRequest.updateMany({ where: { id: requestId, status: "PENDING", providerStartedAt: null, outputJson: { equals: Prisma.DbNull }, expiresAt: { gt: new Date() } },
          data: { status: "RUNNING", providerStartedAt: claimTime } });
      });
      if (!claimed.count) return;
      ownedProviderClaim = claimTime;
      signal.throwIfAborted();
      const result = DecomposeResponse.parse(await ai.decompose({ imageUrl: `data:${metadata.mimeType};base64,${original.toString("base64")}`, layerCount: row.layerCount,
        providerRetryPolicy: "never", ...(row.intent ? { intent: row.intent } : {}) }, { signal, requireRealLayerProvider: true, maxResponseBytes: 32 * 1024 * 1024 }));
      signal.throwIfAborted();
      if (result.usage?.provider !== "FalLayerProvider" || result.layers.length < 2 || result.layers.length > 10) throw new ApiException(502, "真实分层模型未返回完整的透明图层结果。");
      assertStudioLayerBudget(row.sourceWidth, row.sourceHeight, result.layers.length);
      const saved = await prisma.studioDecompositionRequest.updateMany({ where: { id: requestId, status: "RUNNING", outputJson: { equals: Prisma.DbNull }, expiresAt: { gt: new Date() } },
        data: { outputJson: { result, publishedLayers: null } as Prisma.InputJsonValue, archiveExpiresAt: new Date(Date.now() + STUDIO_LAYER_RECOVERY_TTL_MS) } });
      if (!saved.count) return;
      await recordUsage({ workspaceId: row.workspaceId, kind: "DECOMPOSE", status: "SUCCEEDED", provider: result.usage.provider,
        ...(result.usage.model ? { model: result.usage.model } : {}), imageCount: result.layers.length, ...(result.usage.latencyMs !== undefined ? { latencyMs: result.usage.latencyMs } : {}) });
    }
    row = await prisma.studioDecompositionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (row.outputJson) await archiveLayers(row, signal);
  } catch (error) {
    // Never echo provider URLs, headers or prompts from an upstream exception.
    await prisma.studioDecompositionRequest.updateMany({ where: { id: requestId, expiresAt: originalDeadline,
      ...(ownedProviderClaim ? { status: "RUNNING", providerStartedAt: ownedProviderClaim, archiveToken: null } : { status: "PENDING", providerStartedAt: null }) },
      data: { status: "FAILED", error: !ownedProviderClaim && error instanceof ApiException && error.status === 503
        ? "真实分层服务或图层存储尚未配置。原图片已保留，可继续编辑或下载；自动 PSD 未完成，请联系管理员配置。"
        : "AI 分层或图层保存未完成。原图片保持不变；已有模型结果可尝试重新保存，不会自动重复调用模型。", archiveToken: null, archivingStartedAt: null } });
  }
}
async function archiveLayers(row: Row, signal: AbortSignal) {
  const output = outputOf(row); if (!output || output.publishedLayers || !row.archiveExpiresAt || row.archiveExpiresAt.getTime() <= Date.now()) return;
  const oldKeys = keysOf(row), count = output.result.layers.length;
  if (oldKeys.length + count > 30) throw new ApiException(409, "图层保存重试次数已达到上限，请联系管理员检查存储。");
  const token = randomUUID(), prefix = `${row.workspaceId}/studio-layer-assets/${row.projectId}/${row.id}/${token}`;
  const objectKeys = output.result.layers.map((_, index) => `${prefix}/${index}.bin`);
  const claimed = await prisma.studioDecompositionRequest.updateMany({ where: { id: row.id, status: "RUNNING", archiveToken: null, expiresAt: row.expiresAt },
    data: { archiveToken: token, archivingStartedAt: new Date(), objectKeys: [...oldKeys, ...objectKeys] } });
  if (!claimed.count) return;
  try {
  const layers: Layer[] = []; let transparent = false;
  // Read/process/store one layer at a time. Bytes remain encrypted even on a
  // legacy public bucket; only the authenticated raw handler decrypts them.
  for (let index = 0; index < count; index++) {
    signal.throwIfAborted();
    const raw = await readArtifactImageBytes({ imageUrl: output.result.layers[index]!.imageUrl }, signal);
    const image = await inspectStudioLayer(raw, row.sourceWidth, row.sourceHeight, signal); transparent ||= image.hasTransparency;
    const assetId = `sdl_${row.id}_${index}`;
    await artifactDeadline(uploadBuffer(encryptStudioBase(image.body, { workspaceId: row.workspaceId, projectId: row.projectId, outputId: `${row.id}_${index}` }), "application/octet-stream", prefix, signal, objectKeys[index]), signal);
    const { body: _body, hasTransparency: _transparent, ...meta } = image;
    layers.push(StudioDecompositionLayer.parse({ ...meta, assetId, order: index, url: `/api/workspaces/${row.workspaceId}/assets/${assetId}/raw` }));
  }
  if (!transparent) throw new ApiException(422, "模型结果没有透明前景，未将普通图片冒充分层结果。");
  signal.throwIfAborted();
  await prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "StudioDecompositionRequest" WHERE "id"=${row.id} FOR UPDATE`;
    if (!locked.length) throw new ApiException(409, "分层任务已不存在。");
    const current = await tx.studioDecompositionRequest.findUniqueOrThrow({ where: { id: row.id } });
    if (current.status !== "RUNNING" || current.archiveToken !== token || current.expiresAt.getTime() <= Date.now()) throw new ApiException(409, "图层保存期限已结束，未发布部分结果。");
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${row.projectId} AND "workspaceId"=${row.workspaceId} FOR UPDATE`;
    await actorInTransaction(tx, row);
    const original = await tx.asset.findFirst({ where: { id: row.assetId, workspaceId: row.workspaceId, deprecatedAt: null, projectLinks: { some: { projectId: row.projectId } } }, select: { id: true } });
    if (!original) throw new ApiException(409, "原图片已不可用，图层尚未发布。");
    for (const layer of layers) {
      await tx.asset.create({ data: { id: layer.assetId, workspaceId: row.workspaceId, category: "OTHER", source: "UPLOAD", libraryKind: "GENERATED",
        fileName: `AI-layer-${layer.order + 1}.png`, storageKey: objectKeys[layer.order]!, url: layer.url, mimeType: "image/png", sizeBytes: layer.sizeBytes,
        resolution: `${layer.width}×${layer.height}`, availableForGeneration: false } });
      await tx.projectAsset.create({ data: { projectId: row.projectId, assetId: layer.assetId, kind: "MATERIAL" } });
    }
    await tx.studioDecompositionRequest.update({ where: { id: row.id }, data: { status: "SUCCEEDED", outputJson: Prisma.DbNull, publishedLayers: layers as Prisma.InputJsonValue, archiveToken: null, archivingStartedAt: null, error: null } });
  }, { timeout: 15_000 });
  } catch (error) {
    await prisma.studioDecompositionRequest.updateMany({ where: { id: row.id, status: "RUNNING", archiveToken: token, expiresAt: row.expiresAt },
      data: { status: "FAILED", archiveToken: null, archivingStartedAt: null, error: "图层保存未完成，原图片保持不变。可重新保存已有模型结果，不会重复调用模型。" } });
    throw error;
  }
}

/** This branch is called only after the usual session/membership/Asset checks. */
export async function readStudioLayerAsset(workspaceId: string, asset: { id: string; storageKey: string }, signal: AbortSignal) {
  const parts = asset.storageKey.split("/");
  if (parts.length !== 6 || parts[0] !== workspaceId || parts[1] !== "studio-layer-assets" || !/^\d\.bin$/.test(parts[5]!)) throw new ApiException(422, "图层存储记录无效。");
  const row = await prisma.studioDecompositionRequest.findUnique({ where: { id: parts[3]! } });
  if (!row || row.workspaceId !== workspaceId || row.projectId !== parts[2] || row.status !== "SUCCEEDED" || !keysOf(row).includes(asset.storageKey)) throw new ApiException(404, "图层未完成保存。");
  const layer = z.array(StudioDecompositionLayer).parse(row.publishedLayers).find(item => item.assetId === asset.id && item.order === Number(parts[5]![0]));
  if (!layer) throw new ApiException(404, "图层不属于当前任务。");
  const object = await artifactDeadline(getObjectStream(asset.storageKey, signal), signal);
  if (object.contentLength && object.contentLength > 32 * 1024 * 1024 + 32) { object.body.destroy(); throw new ApiException(422, "图层文件过大。"); }
  const encrypted = await artifactDeadline(nodeStreamToBuffer(object.body, 32 * 1024 * 1024 + 32, signal), signal);
  const body = decryptStudioBase(encrypted, { workspaceId, projectId: row.projectId, outputId: `${row.id}_${layer.order}` });
  if (body.length !== layer.sizeBytes || createHash("sha256").update(body).digest("hex") !== layer.assetSha256) throw new ApiException(422, "图层图片完整性校验失败。");
  return body;
}
export async function dispatchStudioDecompositions() {
  await expireStudioDecompositions();
  // The large private result is only a bounded recovery journal. Keep the
  // immutable paid claim/error but retire bytes after its recovery window.
  await prisma.studioDecompositionRequest.updateMany({ where: { status: "FAILED", archiveToken: null,
    archiveExpiresAt: { lte: new Date() }, outputJson: { not: Prisma.DbNull } }, data: { outputJson: Prisma.DbNull } });
  const rows = await prisma.studioDecompositionRequest.findMany({ where: { OR: [{ status: "PENDING", providerStartedAt: null }, { status: "RUNNING", outputJson: { not: Prisma.DbNull }, archiveToken: null }], expiresAt: { gt: new Date() } }, select: { id: true }, take: 50 });
  for (const row of rows) await enqueueStudioDecomposition(row.id);
  // No published key is eligible for orphan cleanup. Keep markers until a
  // successful removal; wait beyond any worker's maximal I/O deadline.
  const abandoned = await prisma.studioDecompositionRequest.findMany({ where: { status: "FAILED", expiresAt: { lt: new Date(Date.now() - 90_000) }, OR: [{ archiveExpiresAt: null }, { archiveExpiresAt: { lt: new Date() } }] }, take: 10 });
  for (const row of abandoned) {
    const remaining = [...keysOf(row)];
    for (const key of [...remaining]) {
      if (!key.startsWith(`${row.workspaceId}/studio-layer-assets/${row.projectId}/${row.id}/`)) continue;
      try { await deleteObject(key, AbortSignal.timeout(5000)); remaining.splice(remaining.indexOf(key), 1); } catch { /* Retain marker. */ }
    }
    if (remaining.length !== keysOf(row).length) await prisma.studioDecompositionRequest.updateMany({ where: { id: row.id, status: "FAILED" }, data: { objectKeys: remaining } });
  }
}
