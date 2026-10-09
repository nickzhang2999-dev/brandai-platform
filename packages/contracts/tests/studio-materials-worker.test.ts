import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ transaction: vi.fn(), gate: vi.fn(), inspect: vi.fn(), upload: vi.fn(), remove: vi.fn(), enqueue: vi.fn(), expire: vi.fn(), creates: vi.fn(), links: vi.fn(), read: vi.fn(), update: vi.fn(), many: vi.fn(), taskUpdate: vi.fn(), query: vi.fn(), workspace: vi.fn(), member: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { $transaction: f.transaction, studioMaterialUpload: { findMany: f.many, update: f.update } } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/s3", () => ({ uploadBuffer: f.upload, deleteObject: f.remove }));
vi.mock("@/lib/studio-materials-image", () => ({ inspectStudioMaterialImage: f.inspect }));
vi.mock("@/lib/studio-materials", () => ({ expireStudioMaterials: f.expire, requireStudioMaterialProject: f.gate }));
vi.mock("@/lib/studio-materials-queue", () => ({ enqueueStudioMaterial: f.enqueue }));
import { runStudioMaterialJob, sweepStudioMaterialUploads } from "../../../apps/web/src/lib/workers/studio-materials.worker";
import { ApiException } from "@/lib/api";

let row: any;
const job = (attemptsMade = 0) => ({ data: { taskId: "task" }, attemptsMade, opts: { attempts: 3 } } as any);
beforeEach(() => {
  vi.resetAllMocks();
  const body = Buffer.from("actual staged bytes");
  row = { taskId: "task", workspaceId: "w", userId: "u", projectId: "p", mimeType: "image/png", fileName: "photo.png", sha256: createHash("sha256").update(body).digest("hex"), body, sizeBytes: body.length, objectKey: "w/studio/p/task.png", expiresAt: new Date(Date.now() + 60000), attemptToken: null, assetId: null, task: { status: "PENDING", progress: 0 } };
  const tx = { $queryRaw: f.query, studioMaterialUpload: { findUnique: f.read, update: f.update }, asyncTask: { update: f.taskUpdate }, brandWorkspace: { findUnique: f.workspace }, membership: { findUnique: f.member }, asset: { create: f.creates }, projectAsset: { create: f.links } };
  f.transaction.mockImplementation(fn => fn(tx));
  f.read.mockImplementation(async () => structuredClone(row));
  f.update.mockImplementation(async ({ data }) => { Object.assign(row, data); return row; });
  f.taskUpdate.mockImplementation(async ({ data }) => { Object.assign(row.task, data); return row.task; });
  f.query.mockResolvedValue([{ archivedAt: null }]); f.workspace.mockResolvedValue({ ownerId: "u" });
  f.gate.mockResolvedValue(undefined); f.inspect.mockResolvedValue({ width: 7, height: 11 });
  f.upload.mockResolvedValue({ key: row.objectKey, url: "https://private-storage.invalid/photo.png" });
  f.creates.mockResolvedValue({ id: "asset" }); f.links.mockResolvedValue({ id: "link" });
});

describe("durable studio upload worker", () => {
  it("stores one authoritative Asset/link and clears staged bytes atomically", async () => {
    await runStudioMaterialJob(job());
    expect(row.task).toMatchObject({ status: "SUCCEEDED", progress: 100, refId: "asset" });
    expect(row.body).toBeNull(); expect(row.assetId).toBe("asset");
    expect(f.upload).toHaveBeenCalledWith(expect.any(Buffer), "image/png", "w/studio/p", expect.any(AbortSignal), "w/studio/p/task.png");
    expect(f.links).toHaveBeenCalledWith({ data: { projectId: "p", assetId: "asset", kind: "MEMBER", usageMode: "EXACT" } });
    await runStudioMaterialJob(job(1));
    expect(f.creates).toHaveBeenCalledTimes(1); expect(f.upload).toHaveBeenCalledTimes(1); expect(f.remove).not.toHaveBeenCalled();
  });
  it("keeps durable bytes for automatic transient retries, then clears them on terminal failure", async () => {
    f.upload.mockRejectedValue(new Error("provider details must not leak"));
    await expect(runStudioMaterialJob(job())).rejects.toThrow("temporarily unavailable");
    expect(row.task.status).toBe("PENDING"); expect(row.body).not.toBeNull();
    await runStudioMaterialJob(job(2));
    expect(row.task.status).toBe("FAILED"); expect(row.task.error).not.toContain("provider details"); expect(row.body).toBeNull(); expect(f.creates).not.toHaveBeenCalled();
  });
  it("rejects changed permissions before S3 and after S3 before committing", async () => {
    f.gate.mockRejectedValueOnce(new ApiException(403, "No upload permission"));
    await runStudioMaterialJob(job()); expect(row.task.status).toBe("FAILED"); expect(f.upload).not.toHaveBeenCalled();
  });
  it("checks real membership again when the storage call completes", async () => {
    f.workspace.mockResolvedValue({ ownerId: "someone-else" }); f.member.mockResolvedValue({ role: "VIEWER" });
    await runStudioMaterialJob(job()); expect(row.task.status).toBe("FAILED"); expect(f.creates).not.toHaveBeenCalled(); expect(row.body).toBeNull();
  });
  it("does not add an image to a project archived during upload", async () => {
    f.query.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes('FROM "Project"') ? [{ archivedAt: new Date() }] : [{ id: "task" }]);
    await runStudioMaterialJob(job()); expect(row.task.status).toBe("FAILED"); expect(f.creates).not.toHaveBeenCalled();
  });
  it("expires stale or missing-byte jobs without touching storage", async () => {
    row.expiresAt = new Date(Date.now() - 1); await runStudioMaterialJob(job());
    expect(row.task.status).toBe("FAILED"); expect(row.body).toBeNull(); expect(f.upload).not.toHaveBeenCalled();
  });
  it("does not let an older worker overwrite a newer claim or delete its object", async () => {
    f.upload.mockImplementation(async () => { row.attemptToken = "newer-worker"; return { key: row.objectKey, url: "https://storage.invalid/a" }; });
    await runStudioMaterialJob(job()); expect(f.creates).not.toHaveBeenCalled(); expect(row.task.status).toBe("RUNNING"); expect(row.attemptToken).toBe("newer-worker"); expect(f.remove).not.toHaveBeenCalled();
  });
  it("rejects tampered staged bytes and invalid decoded images before storage", async () => {
    row.sha256 = "a".repeat(64); await runStudioMaterialJob(job());
    expect(row.task.status).toBe("FAILED"); expect(row.body).toBeNull(); expect(f.upload).not.toHaveBeenCalled();
  });
  it("cleanup preserves finished objects and does not depend on a deleted project's permissions", async () => {
    f.many.mockImplementation(async ({ where }) => where.task.status === "PENDING" ? [{ taskId: "waiting" }] : [{ taskId: "failed", objectKey: "w/studio/deleted/failed.png" }]);
    await sweepStudioMaterialUploads();
    expect(f.enqueue).toHaveBeenCalledWith("waiting"); expect(f.remove).toHaveBeenCalledWith("w/studio/deleted/failed.png", expect.any(AbortSignal));
    expect(f.many.mock.calls[1][0].where.task.status).toBe("FAILED"); expect(f.gate).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith({ where: { taskId: "failed" }, data: { objectCleanedAt: expect.any(Date) } });
  });
  it("failed object deletion retains the durable key for the next cleanup sweep", async () => {
    f.many.mockImplementation(async ({ where }) => where.task.status === "PENDING" ? [] : [{ taskId: "failed", objectKey: "w/studio/p/failed.png" }]);
    f.remove.mockRejectedValue(new Error("storage unavailable")); await sweepStudioMaterialUploads();
    expect(f.update).not.toHaveBeenCalled();
  });
});
