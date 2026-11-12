import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { prisma } from "@brandai/db";
import { createWorkOrder, readWorkOrder, commandWorkOrder } from "../src/lib/deepflare-v2/service";

const url = new URL(process.env.DATABASE_URL ?? "http://missing");
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
  });
  it("does not modify an archived project or allow disabled users", async () => {
    const row = await create();
    await prisma.project.update({ where: { id: scope.projectId }, data: { archivedAt: new Date() } });
    await expect(command(row.id, 1, { type: "CANCEL" })).rejects.toMatchObject({ status: 409 });
    await prisma.project.update({ where: { id: scope.projectId }, data: { archivedAt: null } });
    await prisma.user.update({ where: { id: viewer }, data: { isActive: false } });
    await expect(readWorkOrder(scope, viewer, row.id)).rejects.toMatchObject({ status: 403 });
  });
});
