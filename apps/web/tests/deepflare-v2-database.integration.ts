import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { prisma } from "@brandai/db";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { createWorkOrder, readWorkOrder, commandWorkOrder } from "../src/lib/deepflare-v2/service";

import { dispatchSolPrimary } from "../src/lib/deepflare-v2/native-dispatch";
import { submitStudioGeneration, readStudioGeneration, dispatchStudioGenerations } from "../src/lib/studio-generation";
import { enqueueStudioGeneration } from "../src/lib/studio-generation-queue";

// Keep database-only runs supported. CI also inspects jobs on a dedicated Redis instance.
vi.mock("../src/auth", () => ({ auth: vi.fn() }));
vi.mock("../src/lib/studio-generation-queue", async importOriginal => {
  if (process.env.DF_SOL_TEST_REDIS === "1") return importOriginal();
  return { enqueueStudioGeneration: vi.fn(async () => false) };
});
vi.mock("../src/lib/studio-generation-policy", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/studio-generation-policy")>(),
  requireStudioGenerationServices: vi.fn(async () => undefined),
}));

const url = new URL(process.env.DATABASE_URL ?? "http://missing");
const realQueue = process.env.DF_SOL_TEST_REDIS === "1";
if (realQueue && (!["localhost", "127.0.0.1"].includes(new URL(process.env.REDIS_URL ?? "http://missing").hostname)
    || process.env.BRANDAI_QUEUE_PREFIX !== "df-sol-intake-test"))
  throw new Error("Requires a disposable localhost Redis with the Sol test prefix");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/deepflare_v2_test")
  throw new Error("Requires disposable localhost database deepflare_v2_test; refuses any shared database");
const nonce = randomUUID().replaceAll("-", "");
const owner = "v2_owner_" + nonce, editor = "v2_editor_" + nonce, viewer = "v2_viewer_" + nonce;
const scope = { workspaceId: "v2_brand_" + nonce, projectId: "v2_project_" + nonce };
const other = { workspaceId: "v2_other_" + nonce, projectId: "v2_other_project_" + nonce };
const brief = { text: "香氛上新", mode: "DIRECTION_FIRST", deliverables: [{ id: "main", channel: "主视觉", width: 1024, height: 1024 }], inspiration: [] };
const direction = { summary: "侧光", composition: "独立标题留白" };
const create = () => createWorkOrder(scope, owner, { mutationId: randomUUID(), brief });
const command = (id: string, expectedRevision: number, value: unknown, userId = owner) =>
  commandWorkOrder(scope, userId, id, { mutationId: randomUUID(), expectedRevision, command: value });
async function waiting() {
  const row = await create();
  await command(row.id, 1, { type: "SET_DIRECTION", direction });
  return command(row.id, 2, { type: "SUBMIT" });
}

beforeAll(async () => {
  for (const [id, suffix] of [[owner, "owner"], [editor, "editor"], [viewer, "viewer"]]) {
    await prisma.user.create({ data: { id, email: `${nonce}-${suffix}@example.test` } });
  }
  for (const s of [scope, other]) {
    await prisma.brandWorkspace.create({ data: { id: s.workspaceId, ownerId: owner, name: "Disposable 2.0 test" } });
    await prisma.project.create({ data: { id: s.projectId, workspaceId: s.workspaceId, name: "Disposable 2.0 test" } });
  }
  await prisma.membership.createMany({ data: [
    { userId: editor, workspaceId: scope.workspaceId, role: "EDITOR" },
    { userId: viewer, workspaceId: scope.workspaceId, role: "VIEWER" },
  ] });
});
afterAll(async () => {
  await prisma.brandWorkspace.deleteMany({ where: { id: { in: [scope.workspaceId, other.workspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, editor, viewer] } } });
  await prisma.$disconnect();
});
describe("2.0 actual PostgreSQL transactions", () => {
  it("concurrent duplicate creation produces one work order and event", async () => {
    const input = { mutationId: randomUUID(), brief };
    const [a, b] = await Promise.all([createWorkOrder(scope, owner, input), createWorkOrder(scope, owner, input)]);
    expect(a.id).toBe(b.id);
    expect(await prisma.deepFlareWorkOrderEvent.count({ where: { workOrderId: a.id } })).toBe(1);
    await expect(createWorkOrder(scope, owner, { ...input, brief: { ...brief, text: "不同内容" } })).rejects.toMatchObject({ status: 409 });
  });
  it("restores waiting state after disconnect and commits duplicate approval only once", async () => {
    const row = await waiting();
    await prisma.$disconnect();
    expect((await readWorkOrder(scope, owner, row.id)).state.status).toBe("AWAITING_DIRECTION");
    expect(await prisma.deepFlareWorkOrderDispatch.count({ where: { workOrderId: row.id } })).toBe(0);
    const input = { mutationId: randomUUID(), expectedRevision: 3, command: { type: "CONFIRM_DIRECTION", planVersion: 2 } };
    const results = await Promise.all([commandWorkOrder(scope, owner, row.id, input), commandWorkOrder(scope, owner, row.id, input)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].state.status).toBe("READY");
    expect(results[0].executionAvailable).toBe(false);
    expect(await prisma.deepFlareWorkOrderEvent.count({ where: { workOrderId: row.id } })).toBe(4);
    const dispatch = await prisma.deepFlareWorkOrderDispatch.findMany({ where: { workOrderId: row.id } });
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0].snapshot).toEqual(results[0].state);
    await expect(commandWorkOrder(scope, owner, row.id, { ...input, command: { type: "CANCEL" } })).rejects.toMatchObject({ status: 409 });
  });
  it("two different confirmation mutations cannot create two handoffs", async () => {
    const row = await waiting();
    const result = await Promise.allSettled([
      command(row.id, 3, { type: "CONFIRM_DIRECTION", planVersion: 2 }),
      command(row.id, 3, { type: "CONFIRM_DIRECTION", planVersion: 2 }),
    ]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.deepFlareWorkOrderDispatch.count({ where: { workOrderId: row.id } })).toBe(1);
  });
  it("rejects old revision and old plan confirmations without dispatching", async () => {
    const row = await waiting();
    await command(row.id, 3, { type: "SET_DIRECTION", direction: { ...direction, summary: "新方向" } });
    await command(row.id, 4, { type: "SUBMIT" });
    await expect(command(row.id, 3, { type: "CONFIRM_DIRECTION", planVersion: 2 })).rejects.toMatchObject({ status: 409 });
    await expect(command(row.id, 5, { type: "CONFIRM_DIRECTION", planVersion: 2 })).rejects.toThrow("已更新");
    expect(await prisma.deepFlareWorkOrderDispatch.count({ where: { workOrderId: row.id } })).toBe(0);
  });
  it("rolls back state and audit event if the outbox insert fails", async () => {
    const row = await waiting();
    // Fault injection: force a unique constraint failure; no provider/Generation is fabricated.
    await prisma.deepFlareWorkOrderDispatch.create({ data: { workOrderId: row.id, planVersion: 2, snapshot: {} } });
    await expect(command(row.id, 3, { type: "CONFIRM_DIRECTION", planVersion: 2 })).rejects.toThrow();
    expect((await readWorkOrder(scope, owner, row.id)).state).toEqual(row.state);
    expect(await prisma.deepFlareWorkOrderEvent.count({ where: { workOrderId: row.id } })).toBe(3);
  });
  it("direct production persists a handoff immediately after explicit submission", async () => {
    const row = await createWorkOrder(scope, owner, { mutationId: randomUUID(), brief: { ...brief, mode: "DIRECT" } });
    expect((await command(row.id, 1, { type: "SUBMIT" })).state.status).toBe("READY");
    expect(await prisma.deepFlareWorkOrderDispatch.count({ where: { workOrderId: row.id } })).toBe(1);
  });
  it("enforces workspace and project boundaries on reads and writes", async () => {
    const row = await create();
    await expect(readWorkOrder(other, owner, row.id)).rejects.toMatchObject({ status: 404 });
    await expect(createWorkOrder({ ...scope, projectId: other.projectId }, owner, { mutationId: randomUUID(), brief })).rejects.toMatchObject({ status: 404 });
    await expect(readWorkOrder(other, editor, row.id)).rejects.toMatchObject({ status: 404 });
    await expect(commandWorkOrder(other, owner, row.id, { mutationId: randomUUID(), expectedRevision: 1, command: { type: "CANCEL" } })).rejects.toMatchObject({ status: 404 });
  });
  it("allows viewer reads but forbids viewer mutations", async () => {
    const row = await create();
    expect((await readWorkOrder(scope, viewer, row.id)).id).toBe(row.id);
    await expect(command(row.id, 1, { type: "CANCEL" }, viewer)).rejects.toMatchObject({ status: 403 });
    await expect(createWorkOrder(scope, viewer, { mutationId: randomUUID(), brief })).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks membership even for a previously accepted idempotency key", async () => {
    const input = { mutationId: randomUUID(), brief };
    const row = await createWorkOrder(scope, editor, input);
    await prisma.membership.update({ where: { userId_workspaceId: { userId: editor, workspaceId: scope.workspaceId } }, data: { role: "VIEWER" } });
    await expect(createWorkOrder(scope, editor, input)).rejects.toMatchObject({ status: 403 });
    await expect(command(row.id, 1, { type: "CANCEL" }, editor)).rejects.toMatchObject({ status: 403 });
    await prisma.membership.update({ where: { userId_workspaceId: { userId: editor, workspaceId: scope.workspaceId } }, data: { role: "EDITOR" } });
  });
  it("does not modify an archived project or allow disabled users", async () => {
    const row = await create();
    await prisma.project.update({ where: { id: scope.projectId }, data: { archivedAt: new Date() } });
    await expect(command(row.id, 1, { type: "CANCEL" })).rejects.toMatchObject({ status: 409 });
    await prisma.project.update({ where: { id: scope.projectId }, data: { archivedAt: null } });
    await prisma.user.update({ where: { id: viewer }, data: { isActive: false } });
    await expect(readWorkOrder(scope, viewer, row.id)).rejects.toMatchObject({ status: 403 });
    await prisma.user.update({ where: { id: viewer }, data: { isActive: true } });
  });
});

describe("Sol to native Studio intake", () => {
  it("rejects direct work without an approved template and unsupported dimensions before reservation", async () => {
    vi.stubEnv("DEEPFLARE_V2_ENABLED", "1");
    vi.stubEnv("DEEPFLARE_V2_WORKSPACE_IDS", scope.workspaceId);
    vi.stubEnv("DEEPFLARE_V2_NATIVE_DISPATCH", "1");
    try {
      const direct = await createWorkOrder(scope, owner, { mutationId: randomUUID(), brief: { ...brief, mode: "DIRECT" } });
      await command(direct.id, 1, { type: "SUBMIT" });
      await dispatchSolPrimary();
      expect((await readWorkOrder(scope, owner, direct.id)).nativeDispatch?.failureCode).toBe("APPROVED_DIRECTION_REQUIRED");
      const work = await createWorkOrder(scope, owner, { mutationId: randomUUID(),
        brief: { ...brief, deliverables: [{ ...brief.deliverables[0], width: 765 }] } });
      await command(work.id, 1, { type: "SET_DIRECTION", direction });
      await command(work.id, 2, { type: "SUBMIT" });
      await command(work.id, 3, { type: "CONFIRM_DIRECTION", planVersion: 2 });
      await dispatchSolPrimary();
      expect((await readWorkOrder(scope, owner, work.id)).nativeDispatch?.failureCode).toBe("UNSUPPORTED_PRIMARY_SIZE");
      expect(await prisma.generation.count({ where: scope })).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });
  it("leaves old approvals dormant and blocks a newly queued approval if its editor loses access", async () => {
    vi.stubEnv("DEEPFLARE_V2_ENABLED", "1");
    vi.stubEnv("DEEPFLARE_V2_WORKSPACE_IDS", scope.workspaceId);
    vi.stubEnv("DEEPFLARE_V2_NATIVE_DISPATCH", "0");
    const membership = { userId_workspaceId: { userId: editor, workspaceId: scope.workspaceId } };
    try {
      const make = () => createWorkOrder(scope, editor, { mutationId: randomUUID(), brief: { ...brief, mode: "DIRECT" } });
      const old = await make();
      await command(old.id, 1, { type: "SUBMIT" }, editor);
      vi.stubEnv("DEEPFLARE_V2_NATIVE_DISPATCH", "1");
      const work = await make();
      expect((await command(work.id, 1, { type: "SUBMIT" }, editor)).nativeDispatch?.status).toBe("QUEUED");
      await prisma.membership.update({ where: membership, data: { role: "VIEWER" } });
      await dispatchSolPrimary();
      const blocked = await readWorkOrder(scope, owner, work.id);
      expect(blocked.executionAvailable).toBe(false);
      expect(blocked.nativeDispatch).toEqual({ status: "BLOCKED", failureCode: "STUDIO_403", requestId: null });
      expect((await readWorkOrder(scope, owner, old.id)).executionAvailable).toBe(false);
      expect(await prisma.studioGenerationRequest.count({ where: scope })).toBe(0);
    } finally {
      await prisma.membership.update({ where: membership, data: { role: "EDITOR" } });
      vi.unstubAllEnvs();
    }
  });
  it("recovers an interrupted link transaction, keeps ordinary intake independent and redelivers the same native identity", async () => {
    vi.stubEnv("DEEPFLARE_V2_ENABLED", "1");
    vi.stubEnv("DEEPFLARE_V2_NATIVE_DISPATCH", "1");
    vi.stubEnv("DEEPFLARE_V2_WORKSPACE_IDS", scope.workspaceId);
    try {
      const work = await waiting();
      await command(work.id, 3, { type: "CONFIRM_DIRECTION", planVersion: 2 });
      const ordinaryInput = {
        projectId: scope.projectId, mutationId: randomUUID(), prompt: "普通 Studio 申请",
        sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, documentRevision: 0, workflowRevision: 0,
      };
      const dispatch = await prisma.deepFlareWorkOrderDispatch.findFirstOrThrow({ where: { workOrderId: work.id } });
      // A transaction that cannot save the link must also roll back the native request and quota reservation.
      await prisma.$executeRawUnsafe('ALTER TABLE "DeepFlareWorkOrderDispatch" ADD CONSTRAINT test_interrupt_link CHECK (status <> $$LINKED$$) NOT VALID');
      try { await dispatchSolPrimary(); }
      finally { await prisma.$executeRawUnsafe('ALTER TABLE "DeepFlareWorkOrderDispatch" DROP CONSTRAINT test_interrupt_link'); }
      expect(await prisma.studioGenerationRequest.count({ where: { mutationId: dispatch.executionKey! } })).toBe(0);
      expect(await prisma.generation.count({ where: scope })).toBe(0);
      await prisma.deepFlareWorkOrderDispatch.update({ where: { id: dispatch.id }, data: { nextAttemptAt: new Date(0) } });
      const [ordinary] = await Promise.all([
        submitStudioGeneration(scope.workspaceId, editor, ordinaryInput), dispatchSolPrimary(), dispatchSolPrimary(),
      ]);
      // Move the retry clock forward if serializable contention deferred the Sol request.
      await prisma.deepFlareWorkOrderDispatch.updateMany({ where: { id: dispatch.id, status: "QUEUED" }, data: { nextAttemptAt: new Date(0) } });
      await prisma.$disconnect();
      await dispatchSolPrimary();
      const linked = await readWorkOrder(scope, owner, work.id);
      expect(linked.nativeDispatch).toMatchObject({ status: "LINKED", failureCode: null });
      const nativeId = linked.nativeDispatch!.requestId!;
      expect(nativeId).not.toBe(ordinary.requestId);
      expect(await readStudioGeneration(scope.workspaceId, editor, { projectId: scope.projectId, requestId: ordinary.requestId }))
        .toMatchObject({ requestId: ordinary.requestId, status: "PENDING" });
      expect(await prisma.studioGenerationRequest.count({ where: { mutationId: dispatch.executionKey! } })).toBe(1);
      expect(await prisma.generation.count({ where: scope })).toBe(2);
      const second = await waiting();
      await command(second.id, 3, { type: "CONFIRM_DIRECTION", planVersion: 2 });
      await dispatchSolPrimary();
      expect((await readWorkOrder(scope, owner, second.id)).nativeDispatch)
        .toEqual({ status: "QUEUED", requestId: null, failureCode: "SOL_CAPACITY" });
      expect(await prisma.generation.count({ where: scope })).toBe(2);
      await dispatchStudioGenerations();
      if (realQueue) {
        const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
        const observer = new Queue("generate", { connection, prefix: process.env.BRANDAI_QUEUE_PREFIX });
        const ids = [nativeId, ordinary.requestId];
        try {
          await vi.waitFor(async () => {
            await dispatchStudioGenerations();
            for (const id of ids) expect(await observer.getJobState(id)).toBe("waiting");
          });
          await dispatchStudioGenerations();
          const jobs = (await observer.getWaiting()).filter(job => ids.includes(job.id!));
          expect(jobs).toHaveLength(2);
          for (const job of jobs) {
            const request = await prisma.studioGenerationRequest.findUniqueOrThrow({ where: { id: job.id } });
            expect(job.data.generationId).toBe(request.generationId);
            expect(job.opts.attempts).toBe(1);
          }
        } finally {
          try { for (const id of ids) await observer.remove(id); }
          finally { await observer.close(); connection.disconnect(); }
        }
      } else {
        expect(vi.mocked(enqueueStudioGeneration).mock.calls.map(call => call[0])).toContain(nativeId);
      }
      vi.stubEnv("DEEPFLARE_V2_NATIVE_DISPATCH", "paused");
      expect((await readWorkOrder(scope, owner, work.id)).nativeDispatch?.requestId).toBe(nativeId);
      expect((await readWorkOrder(scope, viewer, work.id)).nativeDispatch?.requestId).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });
});
