import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { StudioConversationInput, StudioConversationIntent, type StudioConversationReference } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { parseStudioConversationIntent, studioConversationNonActionable } from "@/lib/studio-conversation-intent";
import { studioConversationFeedback } from "@/lib/studio-conversation-feedback";
import { submitStudioGeneration } from "@/lib/studio-generation";
import { requireArtifactWrite } from "@/lib/studio-generation-artifacts";
import { validateConversationReferences, conversationGenerationInput, conversationGenerationAcceptance, recoverStudioConversationGeneration } from "@/lib/studio-conversation";
import { enqueueStudioConversation } from "@/lib/studio-conversation-queue";
import { ApiException } from "@/lib/api";
import { studioConversationModelAvailable, resolveStudioConversationModel, unknownStudioConversationIntent } from "@/lib/studio-conversation-model";
import { loadStudioConversationContext } from "@/lib/studio-conversation-context";
import { withConversationChoices } from "@/lib/studio-conversation-choices";
import { assertStudioProjectContextSources } from "@/lib/studio-project-context";
import { readConversationProjectContext, withStudioProjectContext, studioProjectContextForPlanner } from "@/lib/studio-project-context-conversation";

const CLAIM_MS = 60_000;
export async function runStudioConversationJob(job: Job<{ messageId: string }>) {
  const token = randomUUID();
  const row = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "StudioConversationMessage" WHERE "id" = ${job.data.messageId} FOR UPDATE`;
    const found = await tx.studioConversationMessage.findUnique({ where: { id: job.data.messageId }, include: { conversation: true } });
    if (!found || found.generationRequestId || !["PENDING", "RUNNING"].includes(found.status) || found.expiresAt.getTime() <= Date.now()) return null;
    if (found.status === "RUNNING" && found.startedAt && found.startedAt.getTime() > Date.now() - CLAIM_MS) return null;
    await tx.studioConversationMessage.update({ where: { id: found.id }, data: { status: "RUNNING", attemptToken: token, startedAt: new Date() } });
    return found;
  });
  if (!row) return;
  const { workspaceId, projectId, userId } = row.conversation;
  try {
    const originalInput = StudioConversationInput.parse(row.input), projectContext = readConversationProjectContext(row.projectContextJson);
    const input = withStudioProjectContext(originalInput, projectContext);
    const active = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
    if (!active?.isActive) throw new ApiException(403, "账号已停用，消息未调用生成服务。");
    await prisma.$transaction(async tx => {
      await requireArtifactWrite(tx, workspaceId, projectId, userId);
      if (projectContext) await assertStudioProjectContextSources(tx, workspaceId, projectId, projectContext);
      await validateConversationReferences(tx, workspaceId, projectId, input.references, row.acceptedCanvas);
    });
    let previous: StudioConversationReference | undefined;
    // A result is a unique continuation target only when it is also explicitly
    // in this message's references; previous history never invents a target ID.
    const prior = await prisma.studioConversationMessage.findMany({ where: { conversationId: row.conversationId, generationRequestId: { not: null }, createdAt: { lt: row.createdAt } }, orderBy: { createdAt: "desc" }, take: 1 });
    if (prior[0]?.generationRequestId) {
      const outputs = await prisma.studioGeneratedMaterial.findMany({ where: { requestId: prior[0].generationRequestId, workspaceId, projectId, status: "SUCCEEDED" }, select: { assetId: true }, take: 2 });
      if (outputs.length === 1) previous = input.references.find(ref => ref.assetId === outputs[0]!.assetId);
    }
    let intent: StudioConversationIntent;
    // Feedback, questions and explicit holds must never start paid intent
    // parsing or generation, including an unsubmitted legacy saved intent.
    if (studioConversationFeedback(input) || studioConversationNonActionable(input)) {
      // An old worker may have accepted a generation but crashed before linking
      // its receipt. Recover that same request before changing its saved intent.
      const recovered = await recoverStudioConversationGeneration(row);
      if (recovered.generationRequestId) return;
      intent = parseStudioConversationIntent(input, previous);
    }
    else if (row.intent) intent = StudioConversationIntent.parse(row.intent);
    else if (row.intentModelStartedAt) intent = unknownStudioConversationIntent(input);
    else if (await studioConversationModelAvailable()) {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(30_000, row.expiresAt.getTime() - Date.now())));
      // Preparation can fail without a paid call. Claim only after authorized
      // image reads and resizing succeed; never label that failure as UNKNOWN.
      const context = await loadStudioConversationContext(workspaceId, projectId, row.conversationId, row.createdAt, input, signal);
      if (projectContext) {
        await prisma.$transaction(async tx => {
          await requireArtifactWrite(tx, workspaceId, projectId, userId);
          await assertStudioProjectContextSources(tx, workspaceId, projectId, projectContext);
        });
        context.projectContext = studioProjectContextForPlanner(projectContext, input.references);
      }
      signal.throwIfAborted();
      const claimed = await prisma.studioConversationMessage.updateMany({ where: { id: row.id, attemptToken: token, status: "RUNNING", intentModelStartedAt: null, intent: { equals: Prisma.DbNull }, expiresAt: { gt: new Date() } },
        data: { intentModelStartedAt: new Date() } });
      if (!claimed.count) intent = unknownStudioConversationIntent(input);
      else {
        const started = Date.now();
        try { intent = await resolveStudioConversationModel(input, previous, signal, context); }
        catch { intent = unknownStudioConversationIntent(input); }
        console.info("[studio-intent]", JSON.stringify({ revision: "r2", status: intent.modelStatus, elapsedMs: Date.now() - started,
          ...(intent.modelUsage ? { usage: intent.modelUsage } : {}) }));
      }
    } else intent = StudioConversationIntent.parse({ ...parseStudioConversationIntent(input, previous),
      modelStatus: "UNAVAILABLE" });
    // A saved intent is part of the generation's immutable payload hash.
    // Do not enrich legacy/crash-recovered snapshots after accepting them.
    if (!row.intent) intent = withConversationChoices(input, intent);
    const persisted = await prisma.studioConversationMessage.updateMany({ where: { id: row.id, attemptToken: token, status: "RUNNING", expiresAt: { gt: new Date() } }, data: { intent: intent as Prisma.InputJsonValue } });
    if (!persisted.count) return;
    if (intent.action === "clarify") {
      await prisma.studioConversationMessage.updateMany({ where: { id: row.id, attemptToken: token, status: "RUNNING", expiresAt: { gt: new Date() } }, data: { status: "CLARIFICATION", attemptToken: null } }); return;
    }
    const generation = await submitStudioGeneration(workspaceId, userId, conversationGenerationInput(projectId, originalInput, intent, projectContext), conversationGenerationAcceptance(row, originalInput, intent), { messageId: row.id, attemptToken: token });
    if (!("requestId" in generation)) throw new Error("Generation receipt unavailable");
    await prisma.studioConversationMessage.updateMany({ where: { id: row.id, attemptToken: token, status: "RUNNING", generationRequestId: null },
      data: { generationRequestId: generation.requestId, attemptToken: null } });
  } catch (error) {
    const message = error instanceof ApiException ? error.message : "消息暂未完成，原图和输入仍保留。请检查任务状态；不会自动重复调用付费模型。";
    await prisma.studioConversationMessage.updateMany({ where: { id: row.id, attemptToken: token, status: "RUNNING", generationRequestId: null }, data: { status: "FAILED", attemptToken: null, error: message } });
  }
}

/** Reconcile a crash between generation intake and attaching its receipt.
 * Stable mutationId + immutable accepted payload return the original task. */
export async function dispatchStudioConversations() {
  const unknown = await prisma.studioConversationMessage.findMany({ where: { generationRequestId: null, intent: { not: Prisma.DbNull }, status: { in: ["PENDING", "RUNNING", "FAILED"] },
    updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } }, include: { conversation: true }, orderBy: { createdAt: "desc" }, take: 100 });
  await Promise.all(unknown.map(row => recoverStudioConversationGeneration(row)));
  await prisma.studioConversationMessage.updateMany({ where: { status: { in: ["PENDING", "RUNNING"] }, generationRequestId: null, expiresAt: { lte: new Date() } },
    data: { status: "FAILED", attemptToken: null, error: "消息处理超时，请保留输入并查看原任务；系统不会自动再次调用付费模型。" } });
  const rows = await prisma.studioConversationMessage.findMany({ where: { generationRequestId: null, expiresAt: { gt: new Date() },
    OR: [{ status: "PENDING" }, { status: "RUNNING", startedAt: { lt: new Date(Date.now() - CLAIM_MS) } }] }, orderBy: { createdAt: "asc" }, take: 32 });
  await Promise.all(rows.map(row => enqueueStudioConversation(row.id)));
}
export function createStudioConversationWorker() {
  return new Worker("studio-conversation", runStudioConversationJob, { connection, prefix: queuePrefix, concurrency: 2, lockDuration: 90_000 });
}
