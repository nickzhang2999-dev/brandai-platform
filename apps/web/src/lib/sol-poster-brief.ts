import { createHash, randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@brandai/db";
import { SolPosterConfirm, SolPosterInput, SolPosterModelInput, SolPosterModelReply, SolPosterReceipt, StudioGenerationInput } from "@brandai/contracts";
import { acceptStudioGeneration, readStudioGeneration, expireStudioGenerations, runStudioGenerationIntake } from "./studio-generation";
import { hashStudioPayload, requireStudioGenerationServices } from "./studio-generation-policy";
import { lockStudioIntake } from "./studio-intake-lock";
import { enqueueStudioGeneration } from "./studio-generation-queue";
import type { GenerateJobData } from "./workers/generate.worker";
import { ApiException } from "./api";
import { ai } from "./ai";
import { isDeepFlareV2Enabled, nativeDispatchEnabled, posterPlanner } from "./deepflare-v2/feature";
import { requireStudioMaterialProject } from "./studio-materials";
import { requireArtifactWrite } from "./studio-generation-artifacts";
import { resolveStudioSelectedMaterial } from "./studio-generation-edit";
import { requireTrustedStudioBrandProjectMaterial } from "./studio-brand-materials";
import { freezeStudioProjectContext } from "./studio-project-context";
import { getConfirmedRules } from "./rules";
import { enqueueStudioCopywriting } from "./studio-copywriting-queue";
import { recordUsage } from "./usage";
import { z } from "zod";
import { planSessionBrief, SessionBinding, SolSessionReplyError } from "./sol-brief-session";

const kind = "SOL_POSTER_BRIEF_V1";
const waitMs = 6 * 60_000;
const active = ["PENDING", "RUNNING"] as const;
const expired = "简报等待超时。模型回执可能尚未到达，请核对后再提交。";
const Stored = z.object({ userId: z.string(), input: SolPosterInput, assetId: z.string(), facts: SolPosterModelInput,
  planner: z.enum(["dsh", "company"]).optional(),
  styleHash: SolPosterInput.shape.target.shape.assetSha256.optional(),
  brandRulesHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), session:SessionBinding.optional() });
type Row = { id: string; status: string; inputJson: unknown; resultJson: unknown; createdAt: Date; error: string | null };

function hashBrandRules(rules: Awaited<ReturnType<typeof getConfirmedRules>>) {
  return hashStudioPayload([...rules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function receipt(row: Row) {
  const { input, facts, session } = Stored.parse(row.inputJson);
  const saved = row.status==="SUCCEEDED" ? SolPosterModelReply.extend({
    imageRequestId: SolPosterReceipt.shape.imageRequestId,
    audit:z.object({nextStep:z.enum(["ask_audience","ready"]).optional()}).passthrough().optional(),
  }).parse(row.resultJson) : null;
  const result=saved;
  return SolPosterReceipt.parse({ id: row.id, mutationId: input.mutationId, target: input.target,
    product: facts.product, brand: facts.brand, createdAt: row.createdAt.toISOString(), status: row.status, imageRequestId: saved?.imageRequestId,
    styleReference: input.styleAssetId && facts.styleReferenceName ? { assetId: input.styleAssetId, name: facts.styleReferenceName } : undefined,
    conversation: session && input.conversation && {message:input.conversation.message, audience:session.audience,
      designNotes:session.designNotes,
      question:saved && (saved.audit?.nextStep==="ask_audience" || (!saved.audit?.nextStep && !session.audience)) ? "这张海报主要给谁看？" : null,resumed:session.resume,
      reusedDirection:!!input.conversation.direction},
    contextRevision: input.contextRevision, documentRevision: input.documentRevision, error: row.error,
    result: result && { choices: result.choices, approvedCopy: facts.approvedCopy, rules: facts.rules,
      visualRequirements: facts.visualRequirements } });
}

function permit(workspaceId: string, writing: boolean) {
  if (!isDeepFlareV2Enabled(workspaceId)) throw new ApiException(404, "当前工作区未开放 Sol 简报。");
  if (writing && process.env.DEEPFLARE_V2_NATIVE_DISPATCH === "paused") throw new ApiException(503, "Sol 已暂停，仍可查看已有简报。");
}

export async function listPosterBriefs(workspaceId: string, projectId: string, userId: string) {
  permit(workspaceId, false);
  await requireStudioMaterialProject(workspaceId, userId, projectId);
  const where = { workspaceId, refId: projectId, kind, inputJson: { path: ["userId"], equals: userId } };
  await prisma.asyncTask.updateMany({ where: { ...where, status: { in: [...active] }, expiresAt: { lte: new Date() } },
    data: { status: "FAILED", error: expired } });
  return (await prisma.asyncTask.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 })).map(receipt);
}

export async function createPosterBrief(workspaceId: string, projectId: string, userId: string, raw: unknown) {
  permit(workspaceId, true);
  await requireStudioMaterialProject(workspaceId, userId, projectId, true);
  const input = SolPosterInput.parse(raw);
  const id = "spb_" + createHash("sha256").update(JSON.stringify([workspaceId, projectId, userId, input.mutationId])).digest("hex");
  const row = await prisma.$transaction(async tx => {
    // Serialize the per-workspace budget even when two projects submit simultaneously.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(20261126, hashtext(${workspaceId}))::text`;
    await requireArtifactWrite(tx, workspaceId, projectId, userId);
    const previous = await tx.asyncTask.findUnique({ where: { id } });
    if (previous) {
      if (JSON.stringify(Stored.parse(previous.inputJson).input) !== JSON.stringify(input)) throw new ApiException(409, "同一次提交的商品或版本已经变化。");
      return previous;
    }
    const now = new Date();
    const pending = await tx.asyncTask.count({ where: { kind, workspaceId, refId: projectId,
      inputJson: { path: ["userId"], equals: userId }, status: { in: [...active] }, expiresAt: { gt: now } } });
    if (pending) throw new ApiException(409, "上一次简报仍在处理，请查看记录。");
    if (await tx.asyncTask.count({ where: { kind, workspaceId, createdAt: { gt: new Date(+now - 60000) } } }) >= 5)
      throw new ApiException(429, "本分钟简报已达上限，请稍后再试。");
    const doc = await tx.editorDocument.findUnique({ where: { projectId }, select: { canvas: true, workspaceId: true, revision: true } });
    if (doc?.workspaceId !== workspaceId || doc.revision !== input.documentRevision) throw new ApiException(409, "画布已更新，请保存后再选商品。");
    const { assetId } = await resolveStudioSelectedMaterial(tx, workspaceId, projectId, input.target, doc.canvas);
    const material = await requireTrustedStudioBrandProjectMaterial(tx, workspaceId, projectId, assetId, input.target.assetSha256);
    const context = await freezeStudioProjectContext(tx, workspaceId, projectId, input.contextRevision);
    const style = input.styleAssetId ? context.materials.find(item => item.role === "STYLE" && item.assetId === input.styleAssetId) : undefined;
    if (input.styleAssetId && (!style || style.assetId === assetId))
      throw new ApiException(422, "请从本项目已保存的风格素材中选择另一张参考图。");
    const brand = await tx.brandWorkspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
    const rules = await getConfirmedRules(workspaceId, { respectKitAvailability: true, client: tx });
    const products = context.materials.filter(item => item.role === "PRODUCT");
    const matched = products.length === 1 && products[0]?.assetId === assetId
      && products[0].assetSha256 === input.target.assetSha256;
    // A project can hold several products. Keep product-specific claims and styling tied to the selected material.
    const useProjectGoal = matched || products.length === 0;
    const parsed = SolPosterModelInput.safeParse({ product: material.fileName, brand: brand.name,
      ...(style && { styleReferenceName: style.name }),
      goal: useProjectGoal ? context.facts.goal : "", audience: useProjectGoal ? context.facts.audience : "",
      visualRequirements: matched ? context.facts.visualRequirements : "", approvedCopy: matched ? context.facts.approvedCopy : "",
      rules: rules.map(rule => rule.summary) });
    if (!parsed.success) throw new ApiException(422, "已确认的项目或品牌资料超过本次简报的容量，请检查资料。");
    let session: SessionBinding | undefined;
    const planner = posterPlanner(workspaceId);
    if (input.conversation) {
      if (!planner) throw new ApiException(503, "当前环境未启用 Sol 连续对话。");
      const last = await tx.asyncTask.findFirst({where:{kind,workspaceId,refId:projectId,
        inputJson:{path:["userId"],equals:userId}},orderBy:[{createdAt:"desc"},{id:"desc"}]});
      if (input.conversation.parentId && input.conversation.parentId!==last?.id)
        throw new ApiException(409, "对话已有更新，请刷新记录后继续。");
      const affinity = createHash("sha256").update(JSON.stringify([workspaceId,projectId,userId,assetId,
        input.target.assetSha256,input.target.shapeId,input.contextRevision,parsed.data,
        ...(style ? [style.assetId, style.assetSha256] : []), ...(planner === "company" ? [planner] : [])])).digest("hex");
      const previous = last?.status==="SUCCEEDED" && input.conversation.parentId
        ? Stored.parse(last.inputJson) : undefined;
      const previousSession = previous?.session;
      const resume = previousSession?.affinity===affinity;
      const history = resume ? previousSession?.designNotes || previous?.input.conversation?.message : undefined;
      const message = input.conversation.message;
      const designNotes = history && !history.endsWith("\n" + message) && history !== message ? history + "\n" + message : history || message;
      if (designNotes.length > 4000) throw new ApiException(422, "累计需求过长，请选择「从新需求开始」，提交整理后的要求。");
      session = {id:resume ? previousSession!.id : id.slice(4),affinity,resume,designNotes,
        audience:input.conversation.audience || (resume ? previousSession?.audience : "") || parsed.data.audience};
    }
    return tx.asyncTask.create({ data: { id, jobId: id, kind, workspaceId, refId: projectId,
      inputJson: { userId, input, assetId, facts: parsed.data, brandRulesHash: hashBrandRules(rules),
        ...(style && {styleHash: style.assetSha256}), ...(session && planner && {session, planner}) }, expiresAt: new Date(+now + waitMs) } });
  });
  return receipt(row);
}

/** Approval binds this immutable brief to one native request in the same database transaction. */
export async function confirmPosterAppearance(workspaceId: string, projectId: string, userId: string, raw: unknown) {
  permit(workspaceId, false);
  const confirmation = SolPosterConfirm.parse(raw);
  await requireStudioMaterialProject(workspaceId, userId, projectId, true);
  const scope = { kind, workspaceId, refId: projectId, inputJson: { path: ["userId"], equals: userId } };
  const briefWhere = { ...scope, id: confirmation.briefId };
  const brief = await prisma.asyncTask.findFirst({ where: briefWhere });
  if (!brief) throw new ApiException(404, "找不到这份简报。");
  const existing = receipt(brief).imageRequestId;
  if (existing) return readStudioGeneration(workspaceId, userId, { projectId, requestId: existing });
  permit(workspaceId, true);
  if (!nativeDispatchEnabled(workspaceId)) throw new ApiException(503, "当前工作区仅开放简报，尚未开启生图。");
  await requireStudioGenerationServices();
  await expireStudioGenerations();
  const accepted = await runStudioGenerationIntake(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(20261126, hashtext(${workspaceId}))::text`;
    await lockStudioIntake(tx, 2);
    await requireArtifactWrite(tx, workspaceId, projectId, userId);
    const row = await tx.asyncTask.findFirst({ where: briefWhere });
    if (!row) throw new ApiException(404, "找不到这份简报。");
    const view = receipt(row);
    if (view.imageRequestId) return { requestId: view.imageRequestId };
    const { input, assetId, facts, session, brandRulesHash, styleHash } = Stored.parse(row.inputJson);
    if (view.status !== "SUCCEEDED" || !view.result || !session?.audience || view.conversation?.question)
      throw new ApiException(409, "请先完成简报并确认受众。");
    const latest = await tx.asyncTask.findFirst({ where: scope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    if (latest?.id !== row.id) throw new ApiException(409, "简报已有更新，请确认最新一版。");
    if (confirmation.target.shapeId !== input.target.shapeId || confirmation.target.assetSha256 !== input.target.assetSha256 ||
        confirmation.contextRevision !== input.contextRevision) throw new ApiException(409, "商品或项目资料已变化，请重新生成简报。");
    const doc = await tx.editorDocument.findUnique({ where: { projectId } });
    if (doc?.workspaceId !== workspaceId || doc.revision !== confirmation.documentRevision) throw new ApiException(409, "画布已更新，请重新读取。");
    const selected = await resolveStudioSelectedMaterial(tx, workspaceId, projectId, input.target, doc.canvas);
    if (selected.assetId !== assetId) throw new ApiException(409, "选中的商品已被替换。");
    const material = await requireTrustedStudioBrandProjectMaterial(tx, workspaceId, projectId, assetId, input.target.assetSha256);
    const context = await freezeStudioProjectContext(tx, workspaceId, projectId, input.contextRevision);
    const style = input.styleAssetId ? context.materials.find(item => item.assetId === input.styleAssetId && item.role === "STYLE") : undefined;
    if (input.styleAssetId && (!style || style.assetSha256 !== styleHash || style.name !== facts.styleReferenceName))
      throw new ApiException(409, "风格参考已更新，请重新生成简报。");
    const currentRules = await getConfirmedRules(workspaceId, { respectKitAvailability: true, client: tx });
    const brand = await tx.brandWorkspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
    if (brand.name !== facts.brand || material.fileName !== facts.product ||
        brandRulesHash !== hashBrandRules(currentRules))
      throw new ApiException(409, "商品或品牌规范已更新，请重新生成简报。");
    const prompt = [
      "品牌：" + facts.brand, "商品：" + facts.product, "受众：" + session.audience,
      facts.goal && "项目目标：" + facts.goal,
      "设计需求（按时间顺序，调整处以最后一次为准）：\n" + (session.designNotes ?? input.conversation?.message ?? ""),
      facts.visualRequirements && "视觉要求：" + facts.visualRequirements,
      facts.approvedCopy ? "仅使用已确认文案：" + facts.approvedCopy : "不添加商品卖点文案。",
      "本次仅生成一张商品外观海报。构图：" + view.result.choices.appearance + "。按选中原图保留商品颜色、形状与标识。",
      style && "第二张图片仅参考构图、用光与氛围。商品、商标和文案以第一张商品图和本次要求为准。",
    ].filter(Boolean).join("\n");
    if (prompt.length > 4000) throw new ApiException(422, "已确认内容超出单次生图容量，请精简项目资料后重新生成简报。");
    const workflow = await tx.workbenchProjectState.findUnique({ where: { projectId }, select: { workflowRevision: true } });
    const sizeSelection = { ratioKey: "1:1", resolutionTier: "1K" } as const;
    const request = StudioGenerationInput.parse({ projectId, mutationId: randomUUID(), prompt, sizeSelection,
      documentRevision: doc.revision, workflowRevision: workflow?.workflowRevision ?? 0 });
    const native = await acceptStudioGeneration(tx, { workspaceId, userId, projectId, mutationId: request.mutationId }, request,
      hashStudioPayload({ briefId: row.id, request }), { canvas: doc.canvas,
        references: [{ referenceId: assetId, assetId, ...input.target, name: material.fileName,
          width: material.width, height: material.height, purpose: "ADAPTIVE" },
          ...(style ? [{referenceId: style.assetId, assetId: style.assetId, assetSha256: style.assetSha256, name: style.name,
            width: style.width, height: style.height, ...(style.versionId && {versionId: style.versionId}), purpose: "REFERENCE" as const}] : [])],
        intent: { action: "generate", referenceIds: style ? [assetId, style.assetId] : [assetId], targetReferenceId: null, requestedSize: null,
          prompt, clarification: null, sizeSource: "default", sizeSelection, parser: "safe-rules-v1" } });
    await tx.asyncTask.update({ where: { id: row.id }, data: {
      resultJson: { ...(row.resultJson as Prisma.JsonObject), imageRequestId: native.id } as Prisma.InputJsonValue } });
    return { requestId: native.id, job: native.jobData as unknown as GenerateJobData };
  }).catch(async error => {
    // A concurrent confirmation or an interrupted commit can leave a valid receipt.
    // Reconcile against the author's persisted link before reporting that acceptance failed.
    const current = await prisma.asyncTask.findFirst({ where: briefWhere });
    const requestId = current && receipt(current).imageRequestId;
    if (requestId) return { requestId, job: undefined };
    throw error;
  });
  if (accepted.job) await enqueueStudioGeneration(accepted.requestId, accepted.job);
  return readStudioGeneration(workspaceId, userId, { projectId, requestId: accepted.requestId });
}

export async function dispatchPosterBriefs() {
  await prisma.asyncTask.updateMany({ where: { kind, status: { in: [...active] }, expiresAt: { lte: new Date() } },
    data: { status: "FAILED", error: expired } });
  const pending = await prisma.asyncTask.findMany({ where: { kind, status: "PENDING", expiresAt: { gt: new Date() } },
    select: { id: true }, orderBy: { createdAt: "asc" }, take: 30 });
  await Promise.all(pending.map(row => enqueueStudioCopywriting(row.id, "sol-poster-brief")));
}

export async function runPosterBrief(id: string) {
  const row = await prisma.asyncTask.findUnique({ where: { id } });
  if (!row?.refId || row.kind !== kind || !row.expiresAt || row.status !== "PENDING") return;
  const expiresAt = row.expiresAt;
  const projectId = row.refId;
  const live = { id, kind, expiresAt: { gt: new Date() } };
  const claim = await prisma.asyncTask.updateMany({ where: { ...live, status: "PENDING" }, data: { status: "RUNNING" } });
  if (!claim.count) return;
  try {
    const { userId, input, facts, assetId, session, planner = "dsh", styleHash } = Stored.parse(row.inputJson);
    const validate = async () => {
      permit(row.workspaceId, true);
      if (!(await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }))?.isActive)
        throw new ApiException(403, "账号已停用。");
      await requireStudioMaterialProject(row.workspaceId, userId, projectId, true);
      await requireTrustedStudioBrandProjectMaterial(prisma, row.workspaceId, projectId, assetId, input.target.assetSha256);
      if (input.styleAssetId && styleHash) {
        const context = await freezeStudioProjectContext(prisma, row.workspaceId, projectId, input.contextRevision);
        if (!context.materials.some(item => item.role === "STYLE" && item.assetId === input.styleAssetId && item.assetSha256 === styleHash))
          throw new ApiException(409, "风格参考已变化，请重新选择。");
      }
    };
    await validate();
    if (+expiresAt <= Date.now()) throw new Error("expired");
    const signal = AbortSignal.timeout(Math.max(1, Math.min(90_000, +expiresAt - Date.now())));
    let audit;
    let result;
    if (session && input.conversation) {
      if (posterPlanner(row.workspaceId) !== planner) throw new ApiException(503,"简报模型配置已变更，请重新核对。");
      if (planner === "company") {
        const request = SolPosterModelInput.parse({...facts, audience: session.audience, designNotes: session.designNotes});
        result = SolPosterModelReply.parse(await ai.solPosterBrief(request, signal));
        if (input.conversation.direction) result.choices = input.conversation.direction;
        audit = {planner, nextStep: session.audience ? "ready" : "ask_audience"};
      } else {
        const response=await planSessionBrief(facts,input.conversation,session,Math.min(90_000,+expiresAt-Date.now()));
        result=SolPosterModelReply.parse({choices:response.choices,model:response.model});
        audit=response.audit;
      }
    } else { result=SolPosterModelReply.parse(await ai.solPosterBrief(facts,signal)); }
    await recordUsage({ workspaceId: row.workspaceId, userId, kind, status: "SUCCEEDED", model: result.model, totalTokens: result.totalTokens });
    await validate();
    await prisma.asyncTask.updateMany({ where: { id, kind, status: "RUNNING", expiresAt: { gt: new Date() } },
      data: { status: "SUCCEEDED", progress: 100, resultJson: {...result,...(audit && {audit})} as Prisma.InputJsonValue } });
  } catch (err) {
    await prisma.asyncTask.updateMany({ where: { id, kind, status: "RUNNING" }, data: { status: "FAILED",
      error: err instanceof ApiException ? err.message : err instanceof SolSessionReplyError
        ? "文本模型回复的构图格式有误，本次简报未保存。"
        : "简报未取得有效模型回执，请检查模型连接。系统不会自动重发。" } });
  }
}
