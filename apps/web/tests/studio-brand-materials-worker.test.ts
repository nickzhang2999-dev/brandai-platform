import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ transaction: vi.fn(), read: vi.fn(), update: vi.fn(), task: vi.fn(), query: vi.fn(), user: vi.fn(), workspace: vi.fn(), member: vi.fn(), role: vi.fn(), bytes: vi.fn(), inspect: vi.fn(), expire: vi.fn(), pending: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { $transaction: f.transaction, user: { findUnique: f.user }, studioBrandMaterialReceipt: { findMany: f.pending } } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("@/lib/studio-brand-materials", () => ({ expireStudioBrandMaterialVerifications: f.expire }));
vi.mock("@/lib/studio-brand-materials-queue", () => ({ enqueueStudioBrandMaterial: f.enqueue }));
vi.mock("@/lib/studio-generation-artifacts-image", () => ({ readArtifactImageBytes: f.bytes, inspectArtifactImage: f.inspect }));
import { runStudioBrandMaterialJob, sweepStudioBrandMaterialVerifications } from "../src/lib/workers/studio-brand-materials.worker";
import { studioBrandMaterialSourceDigest } from "../src/lib/studio-brand-materials-trust";
import { ApiException } from "@/lib/api";
let row: any;
const bytes = Buffer.from("only a synthetic worker decision fixture"), sha = createHash("sha256").update(bytes).digest("hex");
const job = (attemptsMade = 0) => ({ data: { taskId: "task" }, attemptsMade, opts: { attempts: 3 } } as any);
beforeEach(() => {
  vi.resetAllMocks(); const asset = { id: "a", workspaceId: "w", url: "https://store.invalid/w/a.png", storageKey: "w/a.png", mimeType: "image/png", sizeBytes: bytes.length,
    generationVersionId: null, availableForGeneration: true, deprecatedAt: null };
  row = { taskId: "task", assetId: "a", workspaceId: "w", userId: "u", sourceDigest: studioBrandMaterialSourceDigest(asset), expiresAt: new Date(Date.now() + 60_000),
    attemptToken: null, asset, task: { status: "PENDING" } };
  f.read.mockImplementation(async () => structuredClone(row)); f.update.mockImplementation(async ({ data }) => Object.assign(row, data));
  f.task.mockImplementation(async ({ data }) => Object.assign(row.task, data)); f.query.mockResolvedValue([{ id: "a" }]);
  f.user.mockResolvedValue({ isActive: true }); f.workspace.mockResolvedValue({ ownerId: "u" }); f.role.mockResolvedValue({ role: "EDITOR" });
  f.bytes.mockResolvedValue(bytes); f.inspect.mockResolvedValue({ sha256: sha, width: 4, height: 4, mimeType: "image/png", sizeBytes: bytes.length });
  f.transaction.mockImplementation(fn => fn({ $queryRaw: f.query, studioBrandMaterialReceipt: { findUnique: f.read, update: f.update }, asyncTask: { update: f.task },
    user: { findUnique: f.user }, brandWorkspace: { findUnique: f.workspace }, membership: { findUnique: f.member } }));
});
describe("bounded brand image verification worker (simulated persistence)", () => {
  it("checks actual bytes then durably stores SHA and dimensions, without creating another Asset", async () => {
    await runStudioBrandMaterialJob(job());
    expect(row.task).toMatchObject({ status: "SUCCEEDED", progress: 100, refId: "a" }); expect(row.sha256).toBe(sha); expect(row.attemptToken).toBeNull();
    expect(f.bytes).toHaveBeenCalledWith({ imageUrl: row.asset.url, objectKey: "w/a.png" }, expect.any(AbortSignal));
    expect(f.inspect).toHaveBeenCalledWith(bytes, expect.any(AbortSignal));
    await runStudioBrandMaterialJob(job()); expect(f.bytes).toHaveBeenCalledOnce();
  });
  it("rejects revoked membership and disabled accounts before fetching bytes", async () => {
    f.role.mockRejectedValueOnce(new ApiException(403, "权限不足")); await runStudioBrandMaterialJob(job());
    expect(row.task.status).toBe("FAILED"); expect(f.bytes).not.toHaveBeenCalled();
  });
  it("does not approve mismatched byte length, MIME or metadata changed during inspection", async () => {
    f.inspect.mockResolvedValueOnce({ sha256: sha, width: 4, height: 4, mimeType: "image/jpeg", sizeBytes: bytes.length }); await runStudioBrandMaterialJob(job()); expect(row.task.status).toBe("FAILED");
    row.task.status = "PENDING";
    f.bytes.mockImplementationOnce(async () => { row.asset.url = "https://changed.invalid/a"; return bytes; });
    await runStudioBrandMaterialJob(job()); expect(row.task.status).toBe("FAILED"); expect(row.sha256).toBeUndefined();
  });
  it("never reads a foreign key and never replaces a successful newer claim", async () => {
    row.asset.storageKey = "foreign/a.png"; row.sourceDigest = studioBrandMaterialSourceDigest(row.asset);
    await runStudioBrandMaterialJob(job()); expect(row.task.status).toBe("FAILED"); expect(f.bytes).not.toHaveBeenCalled();
  });
  it("rechecks editor permission and activity when committing after network I/O", async () => {
    f.workspace.mockResolvedValue({ ownerId: "other" }); f.member.mockResolvedValue({ role: "VIEWER" });
    await runStudioBrandMaterialJob(job()); expect(row.task.status).toBe("FAILED"); expect(row.sha256).toBeUndefined();
  });
  it("retries transient storage reads, caps terminal errors, and doesn't disclose backend secrets", async () => {
    f.bytes.mockRejectedValue(new Error("private upstream details"));
    await expect(runStudioBrandMaterialJob(job())).rejects.toThrow("temporarily unavailable"); expect(row.task.status).toBe("PENDING");
    await runStudioBrandMaterialJob(job(2)); expect(row.task.status).toBe("FAILED"); expect(row.task.error).not.toContain("private upstream");
  });
  it("a stalled old attempt cannot overwrite a newer worker or an expired task", async () => {
    f.bytes.mockImplementationOnce(async () => { row.attemptToken = "newer"; return bytes; });
    await runStudioBrandMaterialJob(job()); expect(row.task.status).toBe("RUNNING"); expect(row.sha256).toBeUndefined();
    row.expiresAt = new Date(Date.now() - 1); await runStudioBrandMaterialJob(job()); expect(row.task.status).toBe("FAILED"); expect(f.bytes).toHaveBeenCalledOnce();
  });
  it("a worker restart dispatches durable PENDING rows and applies deadline failure", async () => {
    f.pending.mockResolvedValue([{ taskId: "waiting" }]); await sweepStudioBrandMaterialVerifications();
    expect(f.expire).toHaveBeenCalled(); expect(f.enqueue).toHaveBeenCalledWith("waiting"); expect(f.pending).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
});
