import { createHash } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import {
  DeepFlareV2CreateInput, DeepFlareV2CommandInput, DeepFlareV2State,
  DeepFlareV2Scope, DeepFlareV2Receipt,
} from "@brandai/contracts";
import { initialState, transition } from "./domain";

export class V2AccessError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
type Db = Prisma.TransactionClient;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) => value as Prisma.InputJsonValue;
const receipt = (id: string, scope: DeepFlareV2Scope, state: unknown) =>
  DeepFlareV2Receipt.parse({ id, ...scope, state, executionAvailable: false });

/** Every read/write rechecks active account, membership, brand and project together. */
async function authorize(db: Db, scope: DeepFlareV2Scope, userId: string, write: boolean) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!user?.isActive) throw new V2AccessError(403, "账号不可用");
  const project = await db.project.findFirst({ where: { id: scope.projectId, workspaceId: scope.workspaceId },
    select: { archivedAt: true, workspace: { select: { ownerId: true, memberships: { where: { userId }, select: { role: true } } } } } });
  const role = project?.workspace.ownerId === userId ? "OWNER" : project?.workspace.memberships[0]?.role;
  if (!project || !role || !["OWNER", "EDITOR", "REVIEWER", "VIEWER"].includes(role))
    throw new V2AccessError(404, "项目不存在");
  if (write && !["OWNER", "EDITOR"].includes(role)) throw new V2AccessError(403, "需要项目编辑权限");
  if (write && project.archivedAt) throw new V2AccessError(409, "项目已归档");
}

async function transaction<T>(run: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 5000 });
    } catch (error) {
      if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) continue;
      throw error;
    }
  }
}

export async function createWorkOrder(rawScope: DeepFlareV2Scope, userId: string, raw: unknown) {
  const scope = DeepFlareV2Scope.parse(rawScope), input = DeepFlareV2CreateInput.parse(raw);
  const payloadHash = hash(input);
  return transaction(async db => {
    await authorize(db, scope, userId, true);
    const existing = await db.deepFlareWorkOrder.findFirst({ where: { ...scope, createdBy: userId, mutationId: input.mutationId } });
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new V2AccessError(409, "同一次创建不能换成其他内容");
      return receipt(existing.id, scope, existing.state);
    }
    const state = initialState(input.brief);
    const row = await db.deepFlareWorkOrder.create({ data: { ...scope, createdBy: userId,
      mutationId: input.mutationId, payloadHash, state: json(state),
      events: { create: { actorId: userId, mutationId: input.mutationId, payloadHash,
        revision: state.revision, command: { type: "CREATE" }, snapshot: json(state) } } } });
    return receipt(row.id, scope, row.state);
  });
}

export async function readWorkOrder(rawScope: DeepFlareV2Scope, userId: string, id: string) {
  const scope = DeepFlareV2Scope.parse(rawScope);
  return transaction(async db => {
    await authorize(db, scope, userId, false);
    const row = await db.deepFlareWorkOrder.findFirst({ where: { id, ...scope } });
    if (!row) throw new V2AccessError(404, "工作单不存在");
    return receipt(row.id, scope, row.state);
  });
}

export async function commandWorkOrder(rawScope: DeepFlareV2Scope, userId: string, id: string, raw: unknown) {
  const scope = DeepFlareV2Scope.parse(rawScope), input = DeepFlareV2CommandInput.parse(raw);
  const payloadHash = hash(input);
  return transaction(async db => {
    await authorize(db, scope, userId, true);
    const row = await db.deepFlareWorkOrder.findFirst({ where: { id, ...scope } });
    if (!row) throw new V2AccessError(404, "工作单不存在");
    const previous = await db.deepFlareWorkOrderEvent.findFirst({ where: {
      workOrderId: row.id, actorId: userId, mutationId: input.mutationId,
      workOrder: { ...scope },
    } });
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new V2AccessError(409, "同一次操作不能换成其他内容");
      return receipt(row.id, scope, previous.snapshot);
    }
    if (row.revision !== input.expectedRevision) throw new V2AccessError(409, "工作单已更新，请读取最新版本");
    const state = transition(DeepFlareV2State.parse(row.state), input.command);
    const updated = await db.deepFlareWorkOrder.updateMany({
      where: { id: row.id, ...scope, revision: input.expectedRevision },
      data: { revision: state.revision, state: json(state) },
    });
    if (updated.count !== 1) throw new V2AccessError(409, "工作单已被其他操作更新");
    await db.deepFlareWorkOrderEvent.create({ data: { workOrderId: row.id, actorId: userId,
      mutationId: input.mutationId, payloadHash, revision: state.revision,
      command: json(input.command), snapshot: json(state) } });
    // State + immutable approval evidence + dispatch are committed together.
    // No Redis/provider call in the HTTP path; S2 will attach a bounded outbox consumer.
    if (state.status === "READY") await db.deepFlareWorkOrderDispatch.create({
      data: { workOrderId: row.id, planVersion: state.planVersion, snapshot: json(state) },
    });
    return receipt(row.id, scope, state);
  });
}
