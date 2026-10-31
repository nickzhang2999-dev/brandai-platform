import { createHash } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import { BrandDeletionInput, BrandDeletionPreview, BrandDeletionResult } from "@brandai/contracts";
import { ApiException } from "./api";

type Db = Prisma.TransactionClient;
const active = ["PENDING", "RUNNING"] as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const blockedReason = "品牌仍有排队或处理中的任务，请等待任务结束后再删除。";

async function owner(db: Db, workspaceId: string, userId: string) {
  const workspace = await db.brandWorkspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, ownerId: true } });
  if (!workspace) throw new ApiException(404, "品牌不存在。");
  if (workspace.ownerId !== userId) {
    const membership = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { id: true } });
    throw new ApiException(membership ? 403 : 404, membership ? "只有品牌所有者可以删除品牌。" : "品牌不存在。");
  }
  return workspace;
}

async function impact(db: Db, workspaceId: string, userId: string, name: string) {
  const [projects, assets, rules, terms, prohibitions, inspirationCases, members,
    asyncRows, generationRows, requestRows, conversationRows, layerRows, chatRows, materialRows] = await Promise.all([
    db.project.count({ where: { workspaceId } }), db.asset.count({ where: { workspaceId } }),
    db.brandRule.count({ where: { workspaceId } }), db.complianceTerm.count({ where: { workspaceId } }),
    db.prohibitionRule.count({ where: { workspaceId } }), db.inspirationRecord.count({ where: { workspaceId } }),
    db.membership.count({ where: { workspaceId } }),
    db.asyncTask.findMany({ where: { workspaceId, status: { in: [...active] } }, select: { id: true } }),
    db.generation.findMany({ where: { workspaceId, status: { in: [...active] } }, select: { id: true } }),
    db.studioGenerationRequest.findMany({ where: { workspaceId, status: { in: [...active] } }, select: { generationId: true } }),
    db.studioConversationMessage.findMany({ where: { conversation: { workspaceId }, status: { in: [...active] } }, select: { id: true } }),
    db.studioDecompositionRequest.findMany({ where: { workspaceId, OR: [{ status: { in: [...active] } }, { archiveToken: { not: null } }] }, select: { id: true } }),
    db.inspirationChat.findMany({ where: { workspaceId, status: { in: [...active] } }, select: { id: true } }),
    db.studioGeneratedMaterial.findMany({ where: { workspaceId, status: { in: [...active] } }, select: { outputId: true } }),
  ]);
  // Some tasks have both a domain receipt and an AsyncTask projection; count
  // those once. Generation requests share their generation identity.
  const tasks = new Set<string>(asyncRows.map(row => row.id));
  for (const row of generationRows) tasks.add(`generation:${row.id}`);
  for (const row of requestRows) tasks.add(`generation:${row.generationId}`);
  for (const row of conversationRows) tasks.add(`conversation:${row.id}`);
  for (const row of layerRows) tasks.add(`layers:${row.id}`);
  for (const row of chatRows) tasks.add(row.id);
  for (const row of materialRows) tasks.add(`material:${row.outputId}`);
  const counts = { projects, assets, rules, terms, prohibitions, inspirationCases, members };
  const activeTasks = tasks.size;
  return BrandDeletionPreview.parse({ workspaceId, name, counts, activeTasks, canDelete: !activeTasks,
    blockedReason: activeTasks ? blockedReason : null,
    confirmationToken: digest(["brand-deletion-v1", workspaceId, userId, name, counts, activeTasks]),
  });
}

export async function previewBrandDeletion(workspaceId: string, userId: string) {
  return prisma.$transaction(async db => {
    const workspace = await owner(db, workspaceId, userId);
    return impact(db, workspaceId, userId, workspace.name);
  }, { timeout: 5000 });
}

async function destination(db: Db, workspaceId: string, userId: string, preferredWorkspaceId?: string): Promise<BrandDeletionResult> {
  const accessible = { id: { not: workspaceId }, OR: [{ ownerId: userId }, { memberships: { some: { userId } } }] };
  let next = preferredWorkspaceId && preferredWorkspaceId !== workspaceId
    ? await db.brandWorkspace.findFirst({ where: { ...accessible, id: preferredWorkspaceId }, select: { id: true } }) : null;
  next ??= await db.brandWorkspace.findFirst({ where: accessible, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  const nextWorkspaceId = next?.id ?? null;
  return BrandDeletionResult.parse({ ok: true, deletedWorkspaceId: workspaceId, nextWorkspaceId,
    redirectTo: nextWorkspaceId ? `/studio?workspaceId=${encodeURIComponent(nextWorkspaceId)}#/home` : "/studio" });
}

export async function deleteBrand(workspaceId: string, userId: string, raw: unknown, preferredWorkspaceId?: string) {
  const input = BrandDeletionInput.parse(raw);
  const identity = { workspaceId, userId, mutationId: input.mutationId };
  const payloadHash = digest(input);
  try {
    return await prisma.$transaction(async db => {
      // Serialize concurrent retries independently of the workspace row, which
      // intentionally disappears before a successful DELETE is replayed.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brand-delete:${workspaceId}:${userId}`}))`;
      const prior = await db.brandDeletionReceipt.findUnique({ where: { workspaceId_userId_mutationId: identity } });
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw new ApiException(409, "这次删除请求已用于其他内容，请重新检查品牌。");
        return destination(db, workspaceId, userId, preferredWorkspaceId);
      }
      const locked = await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BrandWorkspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
      if (!locked[0]) throw new ApiException(404, "品牌不存在。");
      const workspace = await owner(db, workspaceId, userId);
      const preview = await impact(db, workspaceId, userId, workspace.name);
      if (!preview.canDelete) throw new ApiException(409, blockedReason);
      if (input.confirmationName !== workspace.name || input.confirmationToken !== preview.confirmationToken) {
        throw new ApiException(409, "品牌名称或删除范围已变化，请重新检查并确认。");
      }
      await db.brandWorkspace.delete({ where: { id: workspaceId } });
      // Audit/usage and durable object-cleanup receipts deliberately survive.
      // No object-store delete is performed by a web request.
      await db.brandDeletionReceipt.create({ data: { ...identity, payloadHash } });
      return destination(db, workspaceId, userId, preferredWorkspaceId);
    }, { maxWait: 1500, timeout: 5000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (["P2003", "P2034", "P2028"].includes(error.code)
      || (error.code === "P2010" && ["23503", "40P01", "55P03"].includes(String(error.meta?.code))))) {
      throw new ApiException(409, "品牌正被其他操作使用，未完成删除；请重新检查后再试。");
    }
    throw error;
  }
}
