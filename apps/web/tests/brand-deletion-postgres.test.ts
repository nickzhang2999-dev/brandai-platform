import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { prisma } from "@brandai/db";
import { deleteBrand, previewBrandDeletion } from "@/lib/brand-deletion";
import { lockTaskWorkspace } from "@/lib/workspace-task-lock";

const isolated = process.env.BRAND_DELETION_TEST_DATABASE_URL;
const suite = isolated ? describe : describe.skip;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
suite("brand deletion real PostgreSQL isolation and concurrent admission", () => {
  let users: string[], spaces: string[], project: string;
  beforeAll(() => {
    const url = new URL(isolated!);
    if (url.hostname !== "127.0.0.1" || url.port !== "55438" || url.pathname !== "/brand_deletion_test" || process.env.DATABASE_URL !== isolated) throw new Error("Explicit isolated local brand_deletion_test database required");
  });
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider or storage calls in deletion tests"); }));
    const prefix = "delete-test-" + randomUUID();
    users = [prefix + "-owner", prefix + "-member", prefix + "-foreign"];
    spaces = [prefix + "-ws", prefix + "-next", prefix + "-foreign"];
    project = prefix + "-project";
    await prisma.user.createMany({ data: users.map(id => ({ id, email: id + "@example.invalid", isActive: true })) });
    await prisma.brandWorkspace.createMany({ data: spaces.map((id, index) => ({ id, ownerId: users[index === 2 ? 2 : 0], name: index ? "另一个合成品牌" : "确认删除测试品牌" })) });
    await prisma.project.create({ data: { id: project, workspaceId: spaces[0], name: "合成项目" } });
    await prisma.membership.create({ data: { userId: users[1], workspaceId: spaces[0], role: "OWNER" } });
  });
  afterEach(async () => {
    await prisma.asyncTask.deleteMany({ where: { workspaceId: { in: spaces } } });
    await prisma.studioDecompositionRequest.deleteMany({ where: { workspaceId: { in: spaces } } });
    await prisma.brandDeletionReceipt.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllGlobals();
  });
  afterAll(async () => { await prisma.$disconnect(); });
  const request = async () => { const preview = await previewBrandDeletion(spaces[0], users[0]); return { confirmationName: preview.name, confirmationToken: preview.confirmationToken, mutationId: randomUUID() }; };
  const task = (status: "PENDING" | "RUNNING" | "FAILED" | "SUCCEEDED" = "PENDING") => prisma.asyncTask.create({ data: { workspaceId: spaces[0], kind: "SYNTHETIC_TEST", status } });
  const layer = (status: "FAILED" | "SUCCEEDED" | "PENDING" = "FAILED") => prisma.studioDecompositionRequest.create({ data: {
    workspaceId: spaces[0], userId: users[0], projectId: project, mutationId: randomUUID(), payloadHash: "a".repeat(64),
    sourceShapeId: "shape", assetId: "synthetic-asset", assetSha256: "a".repeat(64), documentRevision: 1, layerCount: 2,
    sourceWidth: 10, sourceHeight: 10, sourceObjectKey: "synthetic/key", sourceMimeType: "image/png", sourceSizeBytes: 100, status,
    expiresAt: new Date(Date.now() + 60_000), objectKeys: ["synthetic/layer.png"],
  } });

  it("only the actual owner can preview/delete, including a member labelled OWNER", async () => {
    const body = await request();
    for (const user of [users[1], users[2]]) {
      await expect(previewBrandDeletion(spaces[0], user)).rejects.toMatchObject({ status: user === users[1] ? 403 : 404 });
      await expect(deleteBrand(spaces[0], user, body)).rejects.toMatchObject({ status: user === users[1] ? 403 : 404 });
    }
    expect(await prisma.brandWorkspace.count({ where: { id: spaces[0] } })).toBe(1);
  });
  it("previews the real impact and cascades the confirmed brand without deleting physical objects", async () => {
    await prisma.asset.create({ data: { workspaceId: spaces[0], category: "OTHER", fileName: "synthetic.png", storageKey: "synthetic/key", url: "https://never.invalid", mimeType: "image/png" } });
    const preview = await previewBrandDeletion(spaces[0], users[0]);
    expect(preview).toMatchObject({ canDelete: true, activeTasks: 0, counts: { projects: 1, assets: 1, members: 1 } });
    const result = await deleteBrand(spaces[0], users[0], await request(), spaces[2]);
    expect(result).toMatchObject({ ok: true, deletedWorkspaceId: spaces[0], nextWorkspaceId: spaces[1], redirectTo: `/studio?workspaceId=${spaces[1]}#/home` });
    expect(await prisma.project.count({ where: { workspaceId: spaces[0] } })).toBe(0);
    expect(await prisma.asset.count({ where: { workspaceId: spaces[0] } })).toBe(0);
    expect(await prisma.membership.count({ where: { workspaceId: spaces[0] } })).toBe(0);
    expect(await prisma.brandWorkspace.count({ where: { id: spaces[2] } })).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("a stale name, changed impact or malformed confirmation cannot delete", async () => {
    const body = await request();
    await prisma.brandWorkspace.update({ where: { id: spaces[0] }, data: { name: "新名称" } });
    await expect(deleteBrand(spaces[0], users[0], body)).rejects.toMatchObject({ status: 409 });
    const second = await request();
    await prisma.project.create({ data: { workspaceId: spaces[0], name: "新增项目" } });
    await expect(deleteBrand(spaces[0], users[0], second)).rejects.toMatchObject({ status: 409 });
    await expect(deleteBrand(spaces[0], users[0], {})).rejects.toThrow();
    expect(await prisma.brandDeletionReceipt.count({ where: { workspaceId: spaces[0] } })).toBe(0);
  });
  it("lost-response and concurrent replay return one durable receipt, while changed intent and another actor cannot replay", async () => {
    const body = await request();
    const results = await Promise.all([deleteBrand(spaces[0], users[0], body), deleteBrand(spaces[0], users[0], body)]);
    expect(results[0]).toEqual(results[1]);
    expect(await prisma.brandDeletionReceipt.count({ where: { workspaceId: spaces[0] } })).toBe(1);
    expect(await deleteBrand(spaces[0], users[0], body)).toEqual(results[0]);
    await expect(deleteBrand(spaces[0], users[0], { ...body, confirmationName: "different" })).rejects.toMatchObject({ status: 409 });
    await expect(deleteBrand(spaces[0], users[1], body)).rejects.toMatchObject({ status: 404 });
    await expect(deleteBrand(spaces[0], users[0], { ...body, mutationId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  });
  it("last-brand deletion and replay do not recreate a default brand, and replay revalidates a removed next brand", async () => {
    const body = await request();
    expect((await deleteBrand(spaces[0], users[0], body)).nextWorkspaceId).toBe(spaces[1]);
    await prisma.brandWorkspace.delete({ where: { id: spaces[1] } });
    expect(await deleteBrand(spaces[0], users[0], body)).toMatchObject({ nextWorkspaceId: null, redirectTo: "/studio" });
    expect(await prisma.brandWorkspace.count({ where: { ownerId: users[0] } })).toBe(0);
  });
  it("rolls back brand and cascade deletion when the durable receipt cannot commit", async () => {
    const body = await request();
    // This isolated database contains only synthetic fixtures. A real database
    // constraint failure after the delete proves the whole transaction rolls back.
    await prisma.$executeRawUnsafe('ALTER TABLE "BrandDeletionReceipt" ADD CONSTRAINT "brand_deletion_test_receipt_failure" CHECK (false) NOT VALID');
    try {
      await expect(deleteBrand(spaces[0], users[0], body)).rejects.toThrow();
      expect(await prisma.brandWorkspace.count({ where: { id: spaces[0] } })).toBe(1);
      expect(await prisma.project.count({ where: { id: project } })).toBe(1);
      expect(await prisma.membership.count({ where: { workspaceId: spaces[0] } })).toBe(1);
      expect(await prisma.brandDeletionReceipt.count({ where: { workspaceId: spaces[0] } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "BrandDeletionReceipt" DROP CONSTRAINT "brand_deletion_test_receipt_failure"');
    }
    expect((await deleteBrand(spaces[0], users[0], body)).ok).toBe(true);
  });
  it.each(["PENDING", "RUNNING"] as const)("blocks %s work even when its deadline expired", async status => {
    const body = await request(); const row = await task(status);
    await prisma.asyncTask.update({ where: { id: row.id }, data: { expiresAt: new Date(0) } });
    expect(await previewBrandDeletion(spaces[0], users[0])).toMatchObject({ canDelete: false, activeTasks: 1, blockedReason: expect.any(String) });
    await expect(deleteBrand(spaces[0], users[0], body)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.asyncTask.count({ where: { id: row.id } })).toBe(1);
  });
  it("preserves terminal task/object-cleanup receipts and blocks their resurrection or identity rebinding", async () => {
    const row = await task("FAILED"), decomposition = await layer();
    await deleteBrand(spaces[0], users[0], await request());
    expect(await prisma.asyncTask.count({ where: { id: row.id } })).toBe(1);
    expect((await prisma.studioDecompositionRequest.findUniqueOrThrow({ where: { id: decomposition.id } })).objectKeys).toEqual(["synthetic/layer.png"]);
    await prisma.asyncTask.update({ where: { id: row.id }, data: { workspaceId: spaces[0], error: "cleanup checked" } });
    await prisma.studioDecompositionRequest.update({ where: { id: decomposition.id }, data: { objectKeys: [], error: "cleanup checked" } });
    await expect(prisma.asyncTask.update({ where: { id: row.id }, data: { status: "PENDING" } })).rejects.toThrow();
    await expect(prisma.studioDecompositionRequest.update({ where: { id: decomposition.id }, data: { status: "RUNNING" } })).rejects.toThrow();
    await expect(prisma.asyncTask.update({ where: { id: row.id }, data: { workspaceId: spaces[1] } })).rejects.toThrow();
    await expect(prisma.studioDecompositionRequest.update({ where: { id: decomposition.id }, data: { workspaceId: spaces[1] } })).rejects.toThrow();
    await expect(task()).rejects.toThrow(); await expect(layer("PENDING")).rejects.toThrow();
    expect(await prisma.asyncTask.count({ where: { workspaceId: spaces[0], status: { in: ["PENDING", "RUNNING"] } } })).toBe(0);
  });
  it("an archive lease blocks deletion even if its status is already terminal", async () => {
    const row = await layer();
    await prisma.studioDecompositionRequest.update({ where: { id: row.id }, data: { archiveToken: "synthetic-lease" } });
    expect((await previewBrandDeletion(spaces[0], users[0])).activeTasks).toBe(1);
    await expect(deleteBrand(spaces[0], users[0], await request())).rejects.toMatchObject({ status: 409 });
  });
  it("admitted new task holds deletion until commit, then deletion observes and refuses active work", async () => {
    const body = await request(), admitted = deferred(), release = deferred();
    const writer = prisma.$transaction(async tx => {
      await lockTaskWorkspace(tx, spaces[0]);
      await tx.asyncTask.create({ data: { workspaceId: spaces[0], kind: "SYNTHETIC_TEST" } });
      admitted.resolve(); await release.promise;
    });
    await admitted.promise;
    let settled = false;
    const deletion = deleteBrand(spaces[0], users[0], body).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try { await new Promise(resolve => setTimeout(resolve, 80)); expect(settled).toBe(false); } finally { release.resolve(); }
    await writer;
    expect(await deletion).toMatchObject({ error: { status: 409 } });
    expect(await prisma.brandWorkspace.count({ where: { id: spaces[0] } })).toBe(1);
  });
  it("a legacy task insert waiting behind the deletion lock is rejected after commit, with no orphan row", async () => {
    const locked = deferred(), release = deferred();
    const deletion = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "BrandWorkspace" WHERE "id" = ${spaces[0]} FOR UPDATE`;
      locked.resolve(); await release.promise;
      await tx.brandWorkspace.delete({ where: { id: spaces[0] } });
    });
    await locked.promise;
    let settled = false;
    const insertion = task().then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try { await new Promise(resolve => setTimeout(resolve, 80)); expect(settled).toBe(false); } finally { release.resolve(); }
    await deletion;
    expect(await insertion).toHaveProperty("error");
    expect(await prisma.asyncTask.count({ where: { workspaceId: spaces[0] } })).toBe(0);
  });
});
