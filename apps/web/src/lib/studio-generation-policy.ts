import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { type Prisma } from "@brandai/db";
import { CreateGenerationInput, EDITOR_DOCUMENT_PREFIX, EDITOR_DOCUMENT_MAX_DECODED_BYTES, StudioGenerationInput, StudioWorkflowSaveInput, resolveGenerationSize } from "@brandai/contracts";
import { ApiException } from "./api";
import { getEffectiveAiSettings, getEffectiveStorage } from "./settings";
import { prepareGeneration } from "./generation-prepare";
import { getConfirmedRules } from "./rules";
import { workflowAssets, workflowIssues } from "./studio-workflow-codec";
import { listStudioProjectMaterials } from "./studio-project-materials";
import { requireArtifactWrite } from "./studio-generation-artifacts";
import { deriveStudioExactLayout } from "./studio-exact-geometry";

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const hashStudioPayload = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export async function requireStudioGenerationServices() {
  const [settings, storage] = await Promise.all([getEffectiveAiSettings(), getEffectiveStorage()]);
  const provider = settings.image.provider.trim().toLowerCase();
  if (!provider || provider === "mock" || !settings.image.apiKey.trim()) throw new ApiException(503, "真实图片生成服务尚未配置，请联系管理员。演示模型不会用于产品生成。");
  if (!storage.configured) throw new ApiException(503, "对象存储尚未配置，暂时无法保存生成图片。");
}

/** Read authoritative saved workflow and native shapes under the same Project
 * lock as document saves. SHA is only a consistency check, never an owner ID. */
export async function prepareStudioGeneration(db: Prisma.TransactionClient, ws: string, user: string, input: StudioGenerationInput) {
  await requireArtifactWrite(db, ws, input.projectId, user);
  const [state, document] = await Promise.all([
    db.workbenchProjectState.findUnique({ where: { projectId: input.projectId } }),
    db.editorDocument.findUnique({ where: { projectId: input.projectId } }),
  ]);
  if ((state && state.workspaceId !== ws) || (document && document.workspaceId !== ws)) throw new ApiException(404, "项目内容不存在。");
  if ((state?.workflowRevision ?? 0) !== input.workflowRevision || (document?.revision ?? 0) !== input.documentRevision) throw new ApiException(409, "画布或素材用途已变更，请保存最新内容后重新提交。");
  const workflow = StudioWorkflowSaveInput.parse({ projectId: input.projectId, revision: state?.workflowRevision ?? 0,
    mode: state?.workflowMode ?? "generate", target: state?.workflowTarget ?? null, references: state?.workflowReferences ?? [] });
  if (workflow.mode !== "generate" || workflow.target) throw new ApiException(422, "修改原图尚未接入合法图片版本，请保留选择，稍后再试。");
  const active = workflow.references.filter(ref => ref.participates);
  const hasExact = active.some(ref => ref.purpose === "EXACT");
  if (hasExact && !input.outputFrameId) throw new ApiException(422, "严格保留素材需要明确选择输出画框，请选择后重试。");
  if (!hasExact && input.outputFrameId) throw new ApiException(422, "当前未选择严格保留素材，请清除输出画框或明确素材用途。");
  if (input.sizeSelection.ratioKey === "custom" || input.sizeSelection.customRatio) throw new ApiException(422, "当前生成仅支持预设比例，请选择预设比例后重试。");
  const materials = active.length ? await listStudioProjectMaterials(db, ws, input.projectId) : [];
  const view = workflowAssets(input.projectId, document?.canvas ?? "", materials);
  if (workflowIssues(workflow, view.assets).some(issue => issue.blocking)) throw new ApiException(422, "参与生成的素材已删除、替换或不可用，请重新选择。");
  const store = document?.canvas && active.length ? JSON.parse(gunzipSync(Buffer.from(document.canvas.slice(EDITOR_DOCUMENT_PREFIX.length), "base64"), { maxOutputLength: EDITOR_DOCUMENT_MAX_DECODED_BYTES }).toString("utf8")).tldrawSnapshot.document.store : {};
  const expectedDigests: Array<[string, string]> = [];
  const exactReferences: Array<{ shapeId: string; assetId: string; sha256: string; width: number; height: number }> = [];
  const selected = active.map((ref, order) => {
    const shape = ref.shapeId ? view.assets.find(item => item.shapeId === ref.shapeId) : view.assets.find(item => item.assetSha256 === ref.assetSha256);
    const url = shape ? store[shape.shapeId]?.props?.url : null;
    const candidates = [...new Map(materials.filter(item => item.url === url && item.sha256 === ref.assetSha256).map(item => [item.assetId, item])).values()];
    if (candidates.length !== 1) throw new ApiException(422, "素材关联不明确，请重新选择画布图片。");
    // Freeze the persistent material's digest, not a browser-supplied SHA.
    expectedDigests.push([candidates[0]!.assetId, candidates[0]!.sha256]);
    if (ref.purpose === "EXACT") {
      const material = candidates[0]!;
      if (!ref.shapeId || !Number.isSafeInteger(material.width) || !Number.isSafeInteger(material.height) || !material.width || !material.height || material.width < 1 || material.height < 1) {
        throw new ApiException(422, "严格保留需要明确的画布图片及已验证原图尺寸，请重新选择素材。");
      }
      exactReferences.push({ shapeId: ref.shapeId, assetId: material.assetId, sha256: material.sha256, width: material.width, height: material.height });
    }
    return { assetId: candidates[0]!.assetId, mode: ref.purpose, order };
  });
  if (new Set(selected.map(item => item.assetId)).size !== selected.length) throw new ApiException(422, "同一素材被重复选择，请明确保留一个用途。");
  const size = resolveGenerationSize(input.sizeSelection);
  const exactLayout = hasExact ? deriveStudioExactLayout({ store, outputFrameId: input.outputFrameId!, outputWidth: size.width, outputHeight: size.height, references: exactReferences }) : undefined;
  const usages = selected.map(item => item.mode === "EXACT" ? exactLayout!.assetUsages.find(usage => usage.assetId === item.assetId)! : item);
  const prepared = await prepareGeneration(ws, { ...CreateGenerationInput.parse({ projectId: input.projectId, sceneType: "SOCIAL_POSTER", sellingPoint: input.prompt,
    scene: "", chatDisplayText: "", versionCount: 1, textMode: "direct", sizeSelection: input.sizeSelection, assetUsages: usages }), chatDisplayText: input.prompt }, { client: db, persistHardBlock: false });
  const jobData = { ...prepared.jobData, studioExpectedAssetSha256: Object.fromEntries(expectedDigests), ...(exactLayout ? { studioExactLayout: exactLayout } : {}) };
  return { ...prepared, jobData, contextHash: await studioGenerationContextHash(db, ws, input.projectId, jobData) };
}

/** A queued intent keeps its accepted selection while the user keeps editing.
 * Revalidate the authoritative sources and brand policy, not later canvas revisions. */
export async function studioGenerationContextHash(db: Prisma.TransactionClient, ws: string, projectId: string, job: { assetUsages?: {assetId: string}[]; generationId?: string; studioExpectedAssetSha256?: Record<string, string> }) {
  const { generationId: _generationId, ...snapshot } = job;
  const usages = job.assetUsages ?? [];
  const [rules, prohibitions, assets] = await Promise.all([
    getConfirmedRules(ws, { order: "recency", respectKitAvailability: true, client: db }),
    db.prohibitionRule.findMany({ where: { workspaceId: ws, status: "ACTIVE", affectsGeneration: true }, orderBy: { id: "asc" } }),
    db.asset.findMany({ where: { workspaceId: ws, id: { in: usages.map(item => item.assetId) }, availableForGeneration: true, deprecatedAt: null,
      projectLinks: { some: { projectId, project: { workspaceId: ws } } } }, orderBy: { id: "asc" }, select: { id: true, storageKey: true, url: true } }),
  ]);
  if (assets.length !== usages.length) throw new ApiException(422, "Accepted image sources are no longer available.");
  const relatedIds = [...new Set([
    ...rules.flatMap(rule => (rule.type === "logo" || rule.type === "imagery") && Array.isArray(rule.evidence)
      ? rule.evidence.flatMap(item => item && typeof item === "object" && "assetId" in item && typeof item.assetId === "string" ? [item.assetId] : []) : []),
    ...prohibitions.flatMap(item => [item.positiveExampleAssetId, item.negativeExampleAssetId].filter((id): id is string => !!id)),
  ])];
  const relatedAssets = relatedIds.length ? await db.asset.findMany({ where: { workspaceId: ws, id: { in: relatedIds } }, orderBy: { id: "asc" },
    select: { id: true, storageKey: true, url: true, mimeType: true, availableForGeneration: true, deprecatedAt: true } }) : [];
  return hashStudioPayload({ rules: [...rules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), prohibitions, assets, relatedAssets, jobData: snapshot });
}

export function assertStudioGenerationCapacity(local: number, global: number) {
  if (local >= 4 || global >= 16) throw new ApiException(429, "正在生成或等待归档的图片较多，请稍后重试。");
}

/** Providers may return data URLs or temporary HTTPS links. Links remain
 * private and are converted into bounded raw bytes by the archive worker. */
export function validateStudioOutputSource(value: string) {
  if (!value || Buffer.byteLength(value) > 48 * 1024 * 1024) throw new Error("生成结果超过可保存大小。");
  if (value.startsWith("data:")) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2]!.length % 4 || Buffer.from(match[2]!, "base64").length > 32 * 1024 * 1024) throw new Error("生成结果格式或大小不受支持。");
    return "bytes";
  }
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || value.length > 8192) throw new Error("生成结果链接无效。");
  return "upstream-url";
}
