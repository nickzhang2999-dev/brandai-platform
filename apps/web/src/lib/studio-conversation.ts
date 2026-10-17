import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import { StudioConversationInput, StudioConversationDraftInput, StudioConversationDraft, StudioConversationMessage, StudioConversationQuery,
  STUDIO_CONVERSATION_TTL_MS, type StudioConversationReference } from "@brandai/contracts";
import { StudioGenerationInput, StudioConversationIntent } from "@brandai/contracts";
import { ApiException } from "./api";
import { requireStudioMaterialProject } from "./studio-materials";
import { requireArtifactWrite } from "./studio-generation-artifacts";
import { hashStudioPayload } from "./studio-generation-policy";
import { listStudioProjectMaterials } from "./studio-project-materials";
import { workflowAssets } from "./studio-workflow-codec";
import { readStudioGeneration } from "./studio-generation";
import { enqueueStudioConversation } from "./studio-conversation-queue";
import { freezeStudioConversationCanvas } from "./studio-conversation-snapshot";

type Message = Prisma.StudioConversationMessageGetPayload<{ include: { conversation: true } }>;
const own = (workspaceId: string, userId: string, projectId: string) => ({ workspaceId, userId, projectId });

export async function validateConversationReferences(db: Prisma.TransactionClient, workspaceId: string, projectId: string, references: StudioConversationReference[], canvas: string) {
  if (!references.length) return;
  const materials = await listStudioProjectMaterials(db, workspaceId, projectId,
    references.map(ref => `/api/workspaces/${workspaceId}/assets/${ref.assetId}/raw`));
  const shapes = workflowAssets(projectId, canvas, materials).assets;
  for (const ref of references) {
    const candidates = materials.filter(item => item.assetId === ref.assetId && item.sha256 === ref.assetSha256);
    if (!candidates.length || candidates.some(item => item.width !== ref.width || item.height !== ref.height)) throw new ApiException(422, "引用素材已删除、替换或未验证，请重新加入对话。");
    if (ref.shapeId && !shapes.some(shape => shape.shapeId === ref.shapeId && shape.assetSha256 === ref.assetSha256 && shape.valid)) throw new ApiException(409, "引用图片在画布中已删除、隐藏或替换，请重新选择。");
    if (ref.versionId && !await db.asset.findFirst({ where: { id: ref.assetId, workspaceId, generationVersionId: ref.versionId }, select: { id: true } })) throw new ApiException(422, "引用图片版本不匹配。");
  }
}

export function conversationGenerationInput(projectId: string, input: StudioConversationInput, intent: StudioConversationIntent) {
  return StudioGenerationInput.parse({ projectId, mutationId: input.mutationId, prompt: intent.prompt,
    sizeSelection: intent.sizeSelection, documentRevision: input.documentRevision, workflowRevision: input.workflowRevision,
    ...(input.outputFrameId ? { outputFrameId: input.outputFrameId } : {}) });
}

/** Recover a lost DB/HTTP acknowledgement from the original generation row;
 * this path never enqueues or calls any provider. The content hash prevents
 * an unrelated legacy API call with the same UUID becoming this result. */
export async function recoverStudioConversationGeneration(row: Message) {
  if (row.generationRequestId || !row.intent) return row;
  const input = StudioConversationInput.parse(row.input), intent = StudioConversationIntent.parse(row.intent);
  if (intent.action === "clarify") return row;
  const { workspaceId, projectId, userId } = row.conversation;
  const existing = await prisma.studioGenerationRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: { workspaceId, projectId, userId, mutationId: row.mutationId } }, select: { id: true, payloadHash: true } });
  if (!existing) return row;
  const accepted = { canvas: row.acceptedCanvas, references: input.references, intent };
  const expected = hashStudioPayload({ input: conversationGenerationInput(projectId, input, intent), accepted });
  if (existing.payloadHash !== expected) return row;
  await prisma.studioConversationMessage.updateMany({ where: { id: row.id, generationRequestId: null }, data: { generationRequestId: existing.id, status: "RUNNING", attemptToken: null, error: null } });
  return { ...row, generationRequestId: existing.id, status: "RUNNING", error: null };
}

async function receipt(original: Message) {
  const row = await recoverStudioConversationGeneration(original);
  let generation = null;
  let status = row.status;
  let error = row.error;
  if (!row.generationRequestId && ["PENDING", "RUNNING"].includes(status) && row.expiresAt.getTime() <= Date.now()) {
    status = "FAILED"; error = "消息处理超时，请保留输入并查看原任务；系统不会自动再次调用付费模型。";
    await prisma.studioConversationMessage.updateMany({ where: { id: row.id, generationRequestId: null, status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: new Date() } }, data: { status, error, attemptToken: null } });
  }
  if (row.generationRequestId) {
    generation = await readStudioGeneration(row.conversation.workspaceId, row.conversation.userId, { projectId: row.conversation.projectId, requestId: row.generationRequestId });
    if (generation && "status" in generation) {
      if (generation.status === "FAILED") { status = "FAILED"; error = generation.error; }
      else if (generation.status === "SUCCEEDED" && generation.resultState === "READY") status = "SUCCEEDED";
      else if (generation.resultState === "FAILED") { status = "FAILED"; error = generation.archiveError; }
      else status = "RUNNING";
    }
  }
  const intent = row.intent as { clarification?: string } | null;
  return StudioConversationMessage.parse({ messageId: row.id, mutationId: row.mutationId, projectId: row.conversation.projectId,
    text: row.text, references: row.references, status, intent: row.intent, generation, error,
    clarification: intent?.clarification ?? null, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() });
}

export async function submitStudioConversation(workspaceId: string, userId: string, projectId: string, raw: unknown) {
  await requireStudioMaterialProject(workspaceId, userId, projectId, true);
  const input = StudioConversationInput.parse(raw);
  const payloadHash = hashStudioPayload(input);
  let row: Message | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      row = await prisma.$transaction(async tx => {
        await requireArtifactWrite(tx, workspaceId, projectId, userId);
        const identity = own(workspaceId, userId, projectId);
        const conversation = await tx.studioConversation.upsert({ where: { workspaceId_userId_projectId: identity }, create: identity, update: {} });
        const old = await tx.studioConversationMessage.findUnique({ where: { conversationId_mutationId: { conversationId: conversation.id, mutationId: input.mutationId } }, include: { conversation: true } });
        if (old) { if (old.payloadHash !== payloadHash) throw new ApiException(409, "同一次发送不能换成其他内容，请重新发送。"); return old; }
        const [document, workflow] = await Promise.all([tx.editorDocument.findUnique({ where: { projectId } }), tx.workbenchProjectState.findUnique({ where: { projectId } })]);
        if ((document?.revision ?? 0) !== input.documentRevision || (workflow?.workflowRevision ?? 0) !== input.workflowRevision) throw new ApiException(409, "画布或工作流已更新，请保存最新内容后发送。");
        if (document && document.workspaceId !== workspaceId || workflow && workflow.workspaceId !== workspaceId) throw new ApiException(404, "项目不存在。");
        await validateConversationReferences(tx, workspaceId, projectId, input.references, document?.canvas ?? "");
        const pending = await tx.studioConversationMessage.count({ where: { conversationId: conversation.id, status: { in: ["PENDING", "RUNNING"] }, generationRequestId: null, expiresAt: { gt: new Date() } } });
        if (pending >= 4) throw new ApiException(429, "待处理的消息较多，请稍后再发送。");
        return tx.studioConversationMessage.create({ data: { id: "scm_" + randomUUID().replace(/-/g, ""), conversationId: conversation.id,
          mutationId: input.mutationId, payloadHash, text: input.text, references: input.references as Prisma.InputJsonValue,
          input: input as unknown as Prisma.InputJsonValue, acceptedCanvas: freezeStudioConversationCanvas(document?.canvas ?? "", input.references, input.outputFrameId), expiresAt: new Date(Date.now() + STUDIO_CONVERSATION_TTL_MS) }, include: { conversation: true } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 });
      break;
    } catch (error) { if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) continue; throw error; }
  }
  if (!row) throw new ApiException(503, "消息受理暂时不可用，请保留输入并重试。");
  // The outbox is durable even when Redis is down. The handler never awaits AI.
  if (row.status === "PENDING") void enqueueStudioConversation(row.id);
  return receipt(row);
}

/** A project created from the home composer starts with that brief in the
 * chat input, so the user does not retype it. Only offered before any
 * conversation exists; revision 0 keeps the normal save/conflict path. */
async function homeBriefDraft(workspaceId: string, projectId: string) {
  const state = await prisma.workbenchProjectState.findUnique({ where: { projectId }, select: { workspaceId: true, brief: true } });
  if (!state || state.workspaceId !== workspaceId) return null;
  const text = (state.brief ?? "").trim().slice(0, STUDIO_CONVERSATION_DRAFT_MAX);
  if (!text) return null;
  return StudioConversationDraft.parse({ text, references: [], quickEditTargetId: null, sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, revision: 0 });
}
const STUDIO_CONVERSATION_DRAFT_MAX = 4000;

export async function readStudioConversation(workspaceId: string, userId: string, projectId: string, raw: unknown) {
  await requireStudioMaterialProject(workspaceId, userId, projectId);
  const query = StudioConversationQuery.parse(raw);
  const conversation = await prisma.studioConversation.findUnique({ where: { workspaceId_userId_projectId: own(workspaceId, userId, projectId) } });
  if (!conversation) {
    if (query.messageId || query.before) throw new ApiException(404, "消息不存在。");
    return { messages: [], nextCursor: null, draft: await homeBriefDraft(workspaceId, projectId) };
  }
  if (query.messageId) {
    const row = await prisma.studioConversationMessage.findFirst({ where: { id: query.messageId, conversationId: conversation.id }, include: { conversation: true } });
    if (!row) throw new ApiException(404, "消息不存在。"); return receipt(row);
  }
  const anchor = query.before ? await prisma.studioConversationMessage.findFirst({ where: { id: query.before, conversationId: conversation.id }, select: { id: true, createdAt: true } }) : null;
  if (query.before && !anchor) throw new ApiException(404, "分页位置不存在。");
  const rows = await prisma.studioConversationMessage.findMany({ where: { conversationId: conversation.id,
    ...(anchor ? { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] } : {}) },
    include: { conversation: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1 });
  const page = rows.slice(0, query.limit);
  return { messages: await Promise.all(page.map(receipt)), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
    draft: conversation.draft === null ? null : StudioConversationDraft.parse({ ...(conversation.draft as object), revision: conversation.draftRevision }) };
}

export async function saveStudioConversationDraft(workspaceId: string, userId: string, projectId: string, raw: unknown) {
  await requireStudioMaterialProject(workspaceId, userId, projectId, true);
  const input = StudioConversationDraftInput.parse(raw);
  return prisma.$transaction(async tx => {
    await requireArtifactWrite(tx, workspaceId, projectId, userId);
    // Retain deleted/disabled references in a draft, but never retain another
    // brand's IDs. Sending revalidates bytes, availability and canvas state.
    const assetIds = input.references.map(ref => ref.assetId);
    if (assetIds.length && await tx.asset.count({ where: { id: { in: assetIds }, workspaceId } }) !== assetIds.length) throw new ApiException(422, "草稿引用不属于当前品牌，请重新选择。");
    const identity = own(workspaceId, userId, projectId);
    const row = await tx.studioConversation.upsert({ where: { workspaceId_userId_projectId: identity }, create: identity, update: {} });
    const { revision, ...draft } = input;
    if (hashStudioPayload(row.draft) === hashStudioPayload(draft)) return StudioConversationDraft.parse({ ...draft, revision: row.draftRevision });
    const changed = await tx.studioConversation.updateMany({ where: { id: row.id, draftRevision: revision }, data: { draft: draft as Prisma.InputJsonValue, draftRevision: { increment: 1 } } });
    if (!changed.count) throw new ApiException(409, "其他标签页更新了对话草稿，当前输入仍保留，请重新打开项目核对。");
    return StudioConversationDraft.parse({ ...draft, revision: revision + 1 });
  }, { timeout: 10_000 });
}
