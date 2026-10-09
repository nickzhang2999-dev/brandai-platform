import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ tx: vi.fn(), material: vi.fn(), project: vi.fn(), task: vi.fn(), upsert: vi.fn(), update: vi.fn(), pending: vi.fn(), version: vi.fn(), role: vi.fn(), gate: vi.fn(), settings: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../db/src/index", () => ({ Prisma: { DbNull: null, TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } }, prisma: { $transaction: f.tx, studioGeneratedMaterial: { findFirst: f.material }, project: { findFirst: f.project }, asyncTask: { findUnique: f.task, upsert: f.upsert, updateMany: f.update, findMany: f.pending } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("../../../apps/web/src/lib/settings", () => ({ getEffectiveAiSettings: f.settings }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("../../../apps/web/src/lib/studio-generation-compliance-queue", () => ({ enqueueStudioCompliance: f.enqueue }));
import { prisma } from "../../db/src/index";
import { dispatchStudioGenerationCompliance, loadStudioComplianceSource, readStudioGenerationCompliance, registerStudioGenerationCompliance, requireStudioVlm, retryStudioGenerationCompliance, studioComplianceTaskId } from "../../../apps/web/src/lib/studio-generation-compliance";
let material: any, task: any, tx: any;
const sha = "a".repeat(64), input = { projectId: "p", versionId: "v" };
beforeEach(() => {
  vi.resetAllMocks(); delete process.env.AUTO_COMPLIANCE_V1;
  task = null;
  material = { workspaceId: "w", projectId: "p", userId: "u", versionId: "v", assetId: "a", requestId: "r", objectKey: "w/final", sha256: sha,
    asset: { id: "a", workspaceId: "w", storageKey: "w/final", url: "http://private/w/final", generationVersionId: "v", deprecatedAt: null, projectLinks: [{ projectId: "p" }] },
    version: { id: "v", generationId: "g", imageUrl: "http://private/w/final", params: {}, complianceReport: null, generation: { id: "g", workspaceId: "w", projectId: "p" } },
    request: { id: "r", workspaceId: "w", projectId: "p", userId: "u", generationId: "g", status: "SUCCEEDED" },
    output: { requestId: "r", workspaceId: "w", projectId: "p", params: { studioPostprocess: { brandRules: [] } } } };
  f.material.mockImplementation(async ({ where }) => where.workspaceId === material.workspaceId && (!where.userId || where.userId === material.userId) && (!where.projectId || where.projectId === material.projectId) ? structuredClone(material) : null);
  f.project.mockResolvedValue({ archivedAt: null }); f.role.mockResolvedValue({ role: "EDITOR" });
  f.settings.mockResolvedValue({ vlm: { provider: "openai", apiKey: "test-only-key" } });
  f.task.mockImplementation(async () => task ? structuredClone(task) : null);
  f.upsert.mockImplementation(async ({ create }) => { task ??= { ...create, progress: 0 }; return structuredClone(task); });
  f.update.mockImplementation(async ({ where, data }) => {
    if (!task) return { count: 0 };
    if (!where.id) return { count: 0 }; // expiry sweep fixture has no expired rows
    if (where.id !== task.id || where.kind !== task.kind || where.jobId !== task.jobId || where.status !== task.status) return { count: 0 };
    Object.assign(task, data); return { count: 1 };
  });
  tx = { studioGeneratedMaterial: { findFirst: f.material }, project: { findFirst: f.project }, asyncTask: { findUnique: f.task, upsert: f.upsert, updateMany: f.update }, generationVersion: { update: f.version } };
  f.tx.mockImplementation(fn => fn(tx)); f.enqueue.mockResolvedValue(false); f.pending.mockResolvedValue([]);
});

describe("product compliance receipts, outbox and explicit recovery", () => {
  it("registers stable version identity once with a real stored deadline", async () => {
    const first = await registerStudioGenerationCompliance(tx, "w", "v"), second = await registerStudioGenerationCompliance(tx, "w", "v");
    expect(first.id).toBe(studioComplianceTaskId("v")); expect(second.jobId).toBe(first.jobId); expect(second.expiresAt).toEqual(first.expiresAt);
    expect(first.status).toBe("PENDING"); expect(first.expiresAt.getTime() - Date.now()).toBeGreaterThan(350_000);
  });
  it.each(["mock", " MOCK ", "", "   "])("does not accept provider %j as a real check", async provider => {
    f.settings.mockResolvedValue({ vlm: { provider, apiKey: "test-only" } }); await expect(requireStudioVlm()).rejects.toMatchObject({ status: 503 });
  });
  it("disabled automatic checks remain visibly unperformed instead of passing", async () => {
    process.env.AUTO_COMPLIANCE_V1 = "0"; await registerStudioGenerationCompliance(tx, "w", "v");
    const view = await readStudioGenerationCompliance("w", "u", input); expect(view).toMatchObject({ status: "FAILED", report: null, checkedImageSha256: null, canRetry: false });
    delete process.env.AUTO_COMPLIANCE_V1;
  });
  it("recovers previously published versions explicitly and retains outbox when Redis is unavailable", async () => {
    expect(await readStudioGenerationCompliance("w", "u", input)).toMatchObject({ status: "NOT_REQUESTED", taskId: null, expiresAt: null, canRetry: true });
    const receipt = await retryStudioGenerationCompliance("w", "u", input); expect(receipt.status).toBe("PENDING"); expect(task).not.toBeNull();
    const id = task.jobId; await retryStudioGenerationCompliance("w", "u", input); expect(task.jobId).toBe(id); expect(f.version).not.toHaveBeenCalled();
    f.pending.mockResolvedValue([structuredClone(task)]); await dispatchStudioGenerationCompliance(); expect(f.enqueue).toHaveBeenLastCalledWith(task.id, id);
  });
  it("explains unavailable configuration for a version with no check task yet", async () => {
    f.settings.mockResolvedValue({ vlm: { provider: "mock", apiKey: "" } });
    const receipt = await readStudioGenerationCompliance("w", "u", input);
    expect(receipt).toMatchObject({ status: "NOT_REQUESTED", taskId: null, report: null, canRetry: false });
    expect(receipt.error).toContain("尚未配置");
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("only explicit failed retries get a fresh attempt and deadline while clearing stale report", async () => {
    await registerStudioGenerationCompliance(tx, "w", "v"); task.status = "FAILED"; task.error = "incomplete"; const previous = task.jobId;
    const receipt = await retryStudioGenerationCompliance("w", "u", input); expect(receipt.status).toBe("PENDING"); expect(task.jobId).not.toBe(previous);
    expect(f.version).toHaveBeenCalledWith({ where: { id: "v" }, data: { complianceReport: null } });
  });
  it("requires current user ownership and rejects a mismatched authoritative asset", async () => {
    await expect(readStudioGenerationCompliance("w", "other-user", input)).rejects.toMatchObject({ status: 404 });
    material.asset.workspaceId = "other-ws"; await expect(loadStudioComplianceSource(prisma as any, "w", "v")).rejects.toMatchObject({ status: 404 });
  });
  it("only exposes a report bound to current published image and original brand snapshot", async () => {
    await registerStudioGenerationCompliance(tx, "w", "v"); task.status = "SUCCEEDED";
    const source = await loadStudioComplianceSource(prisma as any, "w", "v");
    material.version.params.studioCompliance = { taskId: task.id, jobId: task.jobId, imageSha256: sha, rulesHash: source.rulesHash };
    material.version.complianceReport = { overall: "RISK", visualResults: [{ level: "RISK", reason: "Logo mismatch" }], textResults: [], checkedAt: new Date().toISOString() };
    expect(await readStudioGenerationCompliance("w", "u", input)).toMatchObject({ status: "SUCCEEDED", checkedImageSha256: sha, report: { overall: "RISK" }, canRetry: false });
    material.version.params.studioCompliance.imageSha256 = "b".repeat(64);
    expect(await readStudioGenerationCompliance("w", "u", input)).toMatchObject({ status: "FAILED", report: null, checkedImageSha256: null, canRetry: true });
  });
  it("viewer and archived project receipts never advertise retry permission", async () => {
    f.role.mockResolvedValue({ role: "VIEWER" }); expect((await readStudioGenerationCompliance("w", "u", input)).canRetry).toBe(false);
    f.role.mockResolvedValue({ role: "EDITOR" }); f.project.mockResolvedValue({ archivedAt: new Date() }); expect((await readStudioGenerationCompliance("w", "u", input)).canRetry).toBe(false);
  });
});
