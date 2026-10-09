import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ transaction: vi.fn(), gate: vi.fn(), project: vi.fn(), read: vi.fn(), many: vi.fn(), update: vi.fn(), taskUpdate: vi.fn(), create: vi.fn(), taskCreate: vi.fn(), aggregate: vi.fn(), query: vi.fn(), config: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { $transaction: f.transaction, studioMaterialUpload: { findUnique: f.read, findMany: f.many }, project: { findFirst: f.project } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../../../apps/web/src/lib/settings", () => ({ getEffectiveStorage: f.config }));
vi.mock("../../../apps/web/src/lib/studio-materials-queue", () => ({ enqueueStudioMaterial: f.enqueue }));
import { submitStudioMaterial, readStudioMaterialUpload, listStudioMaterials, expireStudioMaterials } from "../../../apps/web/src/lib/studio-materials";

const mutationId = "831a0280-2cf1-41ba-ac94-621053c4a4c6";
const receiptRow = { taskId: "task", projectId: "p", workspaceId: "w", userId: "u", mutationId, expiresAt: new Date(Date.now() + 60000), task: { status: "PENDING", progress: 0, error: null } };
const request = () => { const form = new FormData(); form.append("file", new Blob(["stored image"], { type: "image/png" }), "photo.png"); form.append("projectId", "p"); form.append("mutationId", mutationId); return new Request("http://127.0.0.1/studio/material-upload", { method: "POST", body: form }); };
beforeEach(() => {
  vi.resetAllMocks();
  f.gate.mockResolvedValue({ role: "OWNER" }); f.project.mockResolvedValue({ archivedAt: null }); f.config.mockResolvedValue({ configured: true });
  f.read.mockResolvedValue(null); f.many.mockResolvedValue([]); f.query.mockResolvedValue([{ archivedAt: null }]); f.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0 }, _count: 0 });
  f.transaction.mockImplementation(fn => fn({ $queryRaw: f.query, studioMaterialUpload: { findUnique: f.read, findMany: f.many, update: f.update, create: f.create, aggregate: f.aggregate }, asyncTask: { updateMany: f.taskUpdate, create: f.taskCreate } }));
  f.create.mockImplementation(async ({ data }) => ({ ...receiptRow, ...data, task: receiptRow.task })); f.enqueue.mockResolvedValue(false);
});

describe("studio upload authority and durable intake", () => {
  it("persists a bounded outbox and PENDING task even if Redis enqueue is unavailable", async () => {
    const result = await submitStudioMaterial("w", "u", request());
    expect(result).toMatchObject({ projectId: "p", status: "PENDING", mutationId });
    expect(f.taskCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: "w", kind: "STUDIO_UPLOAD" }) });
    expect(f.create.mock.calls[0][0].data.body).toEqual(Buffer.from("stored image"));
    expect(f.create.mock.calls[0][0].data.objectKey).toMatch(/^w\/studio\/p\/smu_[a-f0-9]+\.png$/);
    expect(f.query.mock.calls.some(([strings]) => strings.join("").includes("pg_advisory_xact_lock"))).toBe(true);
  });
  it("requires EDITOR before consuming the file and never writes for a viewer", async () => {
    f.gate.mockRejectedValue({ status: 403 }); await expect(submitStudioMaterial("w", "u", request())).rejects.toMatchObject({ status: 403 });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "EDITOR"); expect(f.read).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
  it("rejects unconfigured storage, missing projects and archives without creating tasks", async () => {
    f.config.mockResolvedValue({ configured: false }); await expect(submitStudioMaterial("w", "u", request())).rejects.toMatchObject({ status: 503 });
    f.project.mockResolvedValue(null); await expect(submitStudioMaterial("w", "u", request())).rejects.toMatchObject({ status: 404 });
    f.project.mockResolvedValue({ archivedAt: new Date() }); await expect(submitStudioMaterial("w", "u", request())).rejects.toMatchObject({ status: 409 }); expect(f.create).not.toHaveBeenCalled();
  });
  it("does not let concurrent quota checks reserve beyond the workspace budget", async () => {
    f.aggregate.mockResolvedValue({ _sum: { sizeBytes: 40 * 1024 * 1024 }, _count: 5 });
    await expect(submitStudioMaterial("w", "u", request())).rejects.toMatchObject({ status: 429 }); expect(f.create).not.toHaveBeenCalled();
  });
  it("rejects mutation identity reuse for other bytes", async () => {
    f.read.mockResolvedValue({ ...receiptRow, sha256: "other", mimeType: "image/png", fileName: "photo.png" });
    await expect(submitStudioMaterial("w", "u", request())).rejects.toMatchObject({ status: 409 }); expect(f.create).not.toHaveBeenCalled();
  });
  it("scopes task lookup to current user, project and workspace", async () => {
    f.many.mockImplementation(async ({ where }) => where.userId ? [receiptRow] : []);
    expect(await readStudioMaterialUpload("w", "u", { projectId: "p", taskId: "task" })).toMatchObject({ taskId: "task", status: "PENDING" });
    expect(f.many).toHaveBeenLastCalledWith(expect.objectContaining({ where: { workspaceId: "w", projectId: "p", userId: "u", taskId: "task" }, take: 1 }));
    f.many.mockResolvedValue([]); await expect(readStudioMaterialUpload("w", "u", { projectId: "p", taskId: "foreign-task" })).rejects.toMatchObject({ status: 404 });
  });
  it("lists only real project-linked, nondeprecated assets and never returns storage credentials", async () => {
    await listStudioMaterials("w", "u", { projectId: "p" });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "VIEWER");
    expect(f.many).toHaveBeenLastCalledWith(expect.objectContaining({ where: { workspaceId: "w", projectId: "p", task: { status: "SUCCEEDED" }, asset: { workspaceId: "w", deprecatedAt: null, projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } } } }));
  });
  it("a missing worker still has bounded expiry with an irreversible failure and cleared bytes", async () => {
    f.many.mockResolvedValue([{ taskId: "orphan-task" }]); f.taskUpdate.mockResolvedValue({ count: 1 });
    await expireStudioMaterials("w");
    expect(f.taskUpdate).toHaveBeenCalledWith({ where: { id: "orphan-task", status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: expect.any(String) } });
    expect(f.update).toHaveBeenCalledWith({ where: { taskId: "orphan-task" }, data: { body: null, attemptToken: null } });
    expect(f.gate).not.toHaveBeenCalled();
  });
  it("expiry never clears a job that committed successfully while the sweep was reading", async () => {
    f.many.mockResolvedValue([{ taskId: "finished-task" }]); f.taskUpdate.mockResolvedValue({ count: 0 });
    await expireStudioMaterials(); expect(f.update).not.toHaveBeenCalled();
  });
});
