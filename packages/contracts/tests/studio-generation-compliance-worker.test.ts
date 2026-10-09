import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ tx: vi.fn(), read: vi.fn(), change: vi.fn(), source: vi.fn(), gate: vi.fn(), config: vi.fn(), bytes: vi.fn(), inspect: vi.fn(), refs: vi.fn(), terms: vi.fn(), check: vi.fn(), save: vi.fn(), usage: vi.fn() }));
vi.mock("../../db/src/index", () => ({ Prisma: {}, prisma: { $transaction: f.tx, asyncTask: { updateMany: f.change } } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/ai", () => ({ ai: { complianceCheck: f.check } }));
vi.mock("@/lib/compliance", () => ({ loadTermLib: f.terms }));
vi.mock("@/lib/usage", () => ({ recordUsage: f.usage }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("@/lib/studio-generation-artifacts-image", () => ({ artifactDeadline: async (work: Promise<any>, signal: AbortSignal) => { signal.throwIfAborted(); return work; }, readArtifactImageBytes: f.bytes, inspectArtifactImage: f.inspect }));
vi.mock("@/lib/studio-generation-compliance-images", () => ({ loadStudioComplianceReferences: f.refs }));
vi.mock("@/lib/studio-generation-compliance", () => ({ loadStudioComplianceSource: f.source, requireStudioVlm: f.config, dispatchStudioGenerationCompliance: vi.fn(),
  STUDIO_COMPLIANCE_KIND: "STUDIO_COMPLIANCE", STUDIO_COMPLIANCE_ERROR: "Check incomplete; retry check only", STUDIO_COMPLIANCE_EXPIRED: "Check expired", studioComplianceTaskId: (id: string) => `check-${id}`,
  complianceObject: (value: any) => value && typeof value === "object" ? value : {} }));
import { runStudioGenerationComplianceJob } from "../../../apps/web/src/lib/workers/studio-generation-compliance.worker";
import { ApiException } from "@/lib/api";

let task: any, source: any, report: any, tx: any;
const sha = "a".repeat(64), image = Buffer.from("decoded fixture");
const job = () => ({ data: { taskId: task.id, jobId: task.jobId } } as any);
beforeEach(() => {
  vi.resetAllMocks();
  task = { id: "check-v", kind: "STUDIO_COMPLIANCE", workspaceId: "w", refId: "v", status: "PENDING", jobId: "attempt-1", expiresAt: new Date(Date.now() + 360_000) };
  source = { rulesHash: "rules-at-generation", brandRules: [], row: { workspaceId: "w", projectId: "p", userId: "u", versionId: "v", assetId: "a", objectKey: "w/final", sha256: sha, width: 48, height: 32,
    asset: { url: "http://private.invalid/w/final", storageKey: "w/final" }, request: { generationId: "g" }, version: { params: { original: "kept" } } } };
  report = { overall: "PASS", visualResults: [{ level: "PASS", reason: "Checked brand logo", category: "BRAND_VISUAL" }], textResults: [], checkedAt: new Date().toISOString(), score: 100 };
  tx = { asyncTask: { findUnique: f.read, updateMany: f.change }, generationVersion: { update: f.save } };
  f.tx.mockImplementation(async fn => { const old = structuredClone(task); try { return await fn(tx); } catch (error) { task = old; throw error; } });
  f.read.mockImplementation(async () => structuredClone(task));
  f.change.mockImplementation(async ({ where, data }) => {
    if (task.id !== where.id || task.kind !== where.kind || task.jobId !== where.jobId || task.status !== where.status || (where.expiresAt?.gt && (!task.expiresAt || task.expiresAt <= where.expiresAt.gt))) return { count: 0 };
    Object.assign(task, data); return { count: 1 };
  });
  f.source.mockImplementation(async () => structuredClone(source)); f.bytes.mockResolvedValue(image);
  f.inspect.mockResolvedValue({ sha256: sha, mimeType: "image/png", width: 48, height: 32 });
  f.terms.mockResolvedValue([]); f.refs.mockResolvedValue({ referenceImages: [], audit: [] });
  f.check.mockImplementation(async () => ({ results: [], report: structuredClone(report), visualCheckPerformed: true })); f.usage.mockResolvedValue(undefined);
});

describe("durable product visual compliance (isolated fixtures; no real provider)", () => {
  it("reads authoritative private bytes, reuses original rules and atomically binds the report", async () => {
    await runStudioGenerationComplianceJob(job());
    expect(task.status).toBe("SUCCEEDED"); expect(task.progress).toBe(100);
    expect(f.bytes).toHaveBeenCalledWith({ imageUrl: source.row.asset.url, objectKey: "w/final" }, expect.any(AbortSignal));
    expect(f.check).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: `data:image/png;base64,${image.toString("base64")}`, brandRules: [] }), expect.objectContaining({ requireRealVlmProvider: true, maxResponseBytes: 4 * 1024 * 1024, signal: expect.any(AbortSignal) }));
    expect(f.save.mock.calls[0][0].data).toMatchObject({ complianceReport: report, params: { original: "kept", studioCompliance: { taskId: "check-v", jobId: "attempt-1", imageSha256: sha, rulesHash: "rules-at-generation" } } });
    await runStudioGenerationComplianceJob(job()); expect(f.check).toHaveBeenCalledTimes(1);
  });
  it("records a real forbidden finding as a completed check, not a transport failure", async () => {
    report.overall = "FORBIDDEN"; report.visualResults[0].level = "FORBIDDEN"; report.score = 0;
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("SUCCEEDED"); expect(f.save.mock.calls[0][0].data.complianceReport.overall).toBe("FORBIDDEN");
  });
  it.each(["RUNNING", "SUCCEEDED", "FAILED"])("does not automatically replay %s attempts", async status => {
    task.status = status; await runStudioGenerationComplianceJob(job()); expect(f.check).not.toHaveBeenCalled(); expect(f.bytes).not.toHaveBeenCalled();
  });
  it("ignores obsolete job tokens and expires durable deadlines without a provider call", async () => {
    const stale = job(); stale.data.jobId = "old"; await runStudioGenerationComplianceJob(stale); expect(task.status).toBe("PENDING");
    task.expiresAt = new Date(Date.now() - 1); await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.check).not.toHaveBeenCalled();
  });
  it("fails unconfigured/mock VLM and invalid authoritative image SHA before calling AI", async () => {
    f.config.mockRejectedValueOnce(new ApiException(503, "Configure a real visual model"));
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.bytes).not.toHaveBeenCalled();
    task.status = "PENDING"; f.inspect.mockResolvedValue({ sha256: "b".repeat(64), width: 48, height: 32 });
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.check).not.toHaveBeenCalled();
  });
  it("rejects revoked permissions before provider and again before report publication", async () => {
    f.gate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiException(403, "Editor revoked"));
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.check).not.toHaveBeenCalled();
    task.status = "PENDING"; f.gate.mockReset(); f.gate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiException(409, "Project archived"));
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.check).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
  });
  it("keeps an unperformed fallback PASS separate from genuine judgement and redacts upstream errors", async () => {
    f.check.mockResolvedValueOnce({ results: [], report, visualCheckPerformed: false }); await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.save).not.toHaveBeenCalled();
    task.status = "PENDING"; f.check.mockRejectedValue(new Error("Bearer secret / signed image URL"));
    await runStudioGenerationComplianceJob(job()); expect(task.error).not.toMatch(/secret|signed/); expect(f.save).not.toHaveBeenCalled();
  });
  it("accepts a real clean judgement with empty issues and an explicit score", async () => {
    report.visualResults = []; await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("SUCCEEDED"); expect(f.save.mock.calls[0][0].data.complianceReport.score).toBe(100);
  });
  it("rejects late response after expiry and never overwrites a newer explicit attempt", async () => {
    f.check.mockImplementationOnce(async () => { task.expiresAt = new Date(Date.now() - 1); return { results: [], report, visualCheckPerformed: true }; });
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.save).not.toHaveBeenCalled();
    task.status = "PENDING"; task.expiresAt = new Date(Date.now() + 360_000);
    f.check.mockImplementationOnce(async () => { task.jobId = "attempt-2"; task.status = "PENDING"; return { results: [], report, visualCheckPerformed: true }; });
    await runStudioGenerationComplianceJob(job()); expect(task.jobId).toBe("attempt-2"); expect(task.status).toBe("PENDING"); expect(f.save).not.toHaveBeenCalled();
  });
  it("does not publish a report for a changed archive or brand snapshot", async () => {
    f.check.mockImplementationOnce(async () => { source.rulesHash = "changed"; return { results: [], report, visualCheckPerformed: true }; });
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("FAILED"); expect(f.save).not.toHaveBeenCalled();
  });
  it("preserves an already committed result if the database response is lost", async () => {
    let count = 0; f.tx.mockImplementation(async fn => { const out = await fn(tx); if (++count === 3) throw new Error("reply lost after commit"); return out; });
    await runStudioGenerationComplianceJob(job()); expect(task.status).toBe("SUCCEEDED"); expect(f.save).toHaveBeenCalledTimes(1);
  });
});
