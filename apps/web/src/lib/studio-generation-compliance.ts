import { createHash, randomUUID } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import { BrandRule, ComplianceReport, StudioGenerationComplianceInput, StudioGenerationComplianceView } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { requireArtifactWrite } from "./studio-generation-artifacts";
import { getEffectiveAiSettings } from "./settings";
import { enqueueStudioCompliance } from "./studio-generation-compliance-queue";

export const STUDIO_COMPLIANCE_KIND = "STUDIO_COMPLIANCE";
export const STUDIO_COMPLIANCE_TTL_MS = 6 * 60_000;
export const STUDIO_COMPLIANCE_ERROR = "视觉合规检查未完成，请稍后重试检查；这不会重新生成图片。";
export const STUDIO_COMPLIANCE_EXPIRED = "视觉合规检查超时，未确认检查结果；请重试检查。";
export const studioComplianceEnabled = () => (process.env.AUTO_COMPLIANCE_V1 ?? "1") !== "0";
export const studioComplianceTaskId = (versionId: string) => "sgc_" + createHash("sha256").update(versionId).digest("hex").slice(0, 40);
const attemptId = () => "sgcj_" + randomUUID().replace(/-/g, "");
export const complianceObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Db = Prisma.TransactionClient;
type Task = Prisma.AsyncTaskGetPayload<Record<string, never>>;

/** Registered in the SAME transaction that publishes Version/Asset. */
export async function registerStudioGenerationCompliance(db: Db, workspaceId: string, versionId: string) {
  const enabled = studioComplianceEnabled();
  const task = await db.asyncTask.upsert({ where: { id: studioComplianceTaskId(versionId) }, update: {}, create: {
    id: studioComplianceTaskId(versionId), workspaceId, kind: STUDIO_COMPLIANCE_KIND, refId: versionId, refCount: 0,
    jobId: attemptId(), status: enabled ? "PENDING" : "FAILED", expiresAt: new Date(Date.now() + STUDIO_COMPLIANCE_TTL_MS),
    error: enabled ? null : "自动视觉合规检查已关闭，图片尚未检查。",
  } });
  if (task.workspaceId !== workspaceId || task.kind !== STUDIO_COMPLIANCE_KIND || task.refId !== versionId) throw new ApiException(409, "视觉检查任务归属异常。");
  return task;
}

export async function requireStudioVlm() {
  if (!studioComplianceEnabled()) throw new ApiException(503, "自动视觉合规检查已关闭，图片尚未检查。");
  const settings = await getEffectiveAiSettings();
  const provider = settings.vlm.provider.trim().toLowerCase();
  if (!provider || provider === "mock" || !settings.vlm.apiKey.trim()) throw new ApiException(503, "真实视觉检查服务尚未配置，图片尚未检查；请联系管理员配置后重试。");
  return settings.vlm;
}

/** All IDs are dereferenced through the published archive, never trusted from
 * an AsyncTask ref alone. Source bytes and original brand snapshot stay private. */
export async function loadStudioComplianceSource(db: Db, workspaceId: string, versionId: string, projectId?: string, userId?: string) {
  const row = await db.studioGeneratedMaterial.findFirst({ where: { workspaceId, versionId, status: "SUCCEEDED", ...(projectId ? { projectId } : {}), ...(userId ? { userId } : {}) },
    include: { asset: { include: { projectLinks: { select: { projectId: true } } } },
      version: { include: { generation: { select: { id: true, workspaceId: true, projectId: true } } } },
      output: { select: { requestId: true, workspaceId: true, projectId: true, params: true } },
      request: { select: { id: true, workspaceId: true, projectId: true, userId: true, generationId: true, status: true } } } });
  if (!row || !row.version || !row.asset || !row.sha256 || row.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(row.sha256)
    || row.version.generation.workspaceId !== workspaceId || row.version.generation.projectId !== row.projectId
    || row.request.workspaceId !== workspaceId || row.request.projectId !== row.projectId || row.request.userId !== row.userId || row.request.status !== "SUCCEEDED"
    || row.request.generationId !== row.version.generationId || row.output.requestId !== row.requestId || row.output.workspaceId !== workspaceId || row.output.projectId !== row.projectId
    || row.asset.workspaceId !== workspaceId || row.asset.id !== row.assetId || row.asset.generationVersionId !== versionId || row.asset.deprecatedAt
    || !row.asset.projectLinks.some(link => link.projectId === row.projectId) || row.asset.storageKey !== row.objectKey || row.version.imageUrl !== row.asset.url) {
    throw new ApiException(404, "已归档的生成图片不存在或已失效。");
  }
  const snapshot = complianceObject(complianceObject(row.output.params).studioPostprocess);
  const parsedRules = BrandRule.array().safeParse(snapshot.brandRules);
  if (!parsedRules.success) throw new ApiException(422, "原始品牌规则快照不可用，未进行视觉检查。");
  const rulesHash = createHash("sha256").update(JSON.stringify(parsedRules.data)).digest("hex");
  return { row, brandRules: parsedRules.data, rulesHash };
}
export type StudioComplianceSource = Awaited<ReturnType<typeof loadStudioComplianceSource>>;

export function studioComplianceReport(source: StudioComplianceSource, task: Task | null) {
  if (!task || task.status !== "SUCCEEDED" || task.workspaceId !== source.row.workspaceId || task.refId !== source.row.versionId || task.kind !== STUDIO_COMPLIANCE_KIND) return null;
  const binding = complianceObject(complianceObject(source.row.version!.params).studioCompliance);
  if (binding.taskId !== task.id || binding.jobId !== task.jobId || binding.imageSha256 !== source.row.sha256 || binding.rulesHash !== source.rulesHash) return null;
  const parsed = ComplianceReport.safeParse(source.row.version!.complianceReport);
  return parsed.success ? parsed.data : null;
}

export async function expireStudioGenerationCompliance() {
  // Only our kind owns this nullable deadline; legacy async task behavior stays unchanged.
  await prisma.asyncTask.updateMany({ where: { kind: STUDIO_COMPLIANCE_KIND, expiresAt: null },
    data: { status: "FAILED", expiresAt: new Date(), error: STUDIO_COMPLIANCE_EXPIRED } });
  await prisma.asyncTask.updateMany({ where: { kind: STUDIO_COMPLIANCE_KIND, status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } },
    data: { status: "FAILED", error: STUDIO_COMPLIANCE_EXPIRED } });
}

export async function dispatchStudioGenerationCompliance() {
  await expireStudioGenerationCompliance();
  const pending = await prisma.asyncTask.findMany({ where: { kind: STUDIO_COMPLIANCE_KIND, status: "PENDING", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" }, take: 50 });
  await Promise.all(pending.filter(task => task.jobId).map(task => enqueueStudioCompliance(task.id, task.jobId!)));
}

export async function readStudioGenerationCompliance(workspaceId: string, userId: string, raw: unknown) {
  const { projectId, versionId } = StudioGenerationComplianceInput.parse(raw);
  const { role } = await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  await expireStudioGenerationCompliance();
  // A report and its task token are committed together; read the same database
  // snapshot so polling cannot mistake an in-flight completion for corruption.
  const { source, project, task } = await prisma.$transaction(async tx => ({
    source: await loadStudioComplianceSource(tx, workspaceId, versionId, projectId, userId),
    project: await tx.project.findFirst({ where: { id: projectId, workspaceId }, select: { archivedAt: true } }),
    task: await tx.asyncTask.findUnique({ where: { id: studioComplianceTaskId(versionId) } }),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10_000 });
  if (!project) throw new ApiException(404, "项目不存在。");
  if (task && (task.workspaceId !== workspaceId || task.kind !== STUDIO_COMPLIANCE_KIND || task.refId !== versionId)) throw new ApiException(404, "视觉检查任务不存在。");
  const report = studioComplianceReport(source, task);
  const invalidResult = task?.status === "SUCCEEDED" && !report;
  let configured = false;
  let configurationError: string | null = null;
  try { await requireStudioVlm(); configured = true; }
  catch (error) { configurationError = error instanceof ApiException ? error.message : "检查服务配置暂时无法读取，请联系管理员检查后重试。"; }
  const status = invalidResult ? "FAILED" : task?.status ?? "NOT_REQUESTED";
  return StudioGenerationComplianceView.parse({ taskId: task?.id ?? null, versionId, status,
    progress: task?.progress ?? 0, expiresAt: task?.expiresAt?.toISOString() ?? null,
    checkedImageSha256: report ? source.row.sha256 : null, report,
    error: invalidResult ? "检查结果与当前图片或品牌快照不一致，请重新检查。" : task?.error ?? (status === "NOT_REQUESTED" ? configurationError : null),
    canRetry: (status === "FAILED" || status === "NOT_REQUESTED") && !project.archivedAt && (role === "EDITOR" || role === "OWNER") && configured });
}

/** Explicit retry consumes another VLM check only; image generation is never touched. */
export async function retryStudioGenerationCompliance(workspaceId: string, userId: string, raw: unknown) {
  const { projectId, versionId } = StudioGenerationComplianceInput.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  await requireStudioVlm();
  await expireStudioGenerationCompliance();
  const task = await prisma.$transaction(async tx => {
    await requireArtifactWrite(tx, workspaceId, projectId, userId);
    const source = await loadStudioComplianceSource(tx, workspaceId, versionId, projectId, userId);
    const existing = await tx.asyncTask.findUnique({ where: { id: studioComplianceTaskId(versionId) } });
    if (!existing) return registerStudioGenerationCompliance(tx, workspaceId, versionId);
    if (existing.workspaceId !== workspaceId || existing.kind !== STUDIO_COMPLIANCE_KIND || existing.refId !== versionId) throw new ApiException(404, "视觉检查任务不存在。");
    if (existing.status === "PENDING" || existing.status === "RUNNING" || studioComplianceReport(source, existing)) return existing;
    const jobId = attemptId(), expiresAt = new Date(Date.now() + STUDIO_COMPLIANCE_TTL_MS);
    const changed = await tx.asyncTask.updateMany({ where: { id: existing.id, kind: STUDIO_COMPLIANCE_KIND, jobId: existing.jobId, status: existing.status },
      data: { status: "PENDING", progress: 0, error: null, refCount: 0, jobId, expiresAt } });
    if (!changed.count) throw new ApiException(409, "检查状态已更新，请刷新后重试。");
    await tx.generationVersion.update({ where: { id: versionId }, data: { complianceReport: Prisma.DbNull } });
    return { ...existing, status: "PENDING" as const, jobId, expiresAt };
  }, { timeout: 10_000 });
  if (task.status === "PENDING" && task.jobId) await enqueueStudioCompliance(task.id, task.jobId);
  return readStudioGenerationCompliance(workspaceId, userId, { projectId, versionId });
}
