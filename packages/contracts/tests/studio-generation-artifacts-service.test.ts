import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ transaction: vi.fn(), request: vi.fn(), ownedRequest: vi.fn(), outputs: vi.fn(), artifacts: vi.fn(), project: vi.fn(), query: vi.fn(), workspace: vi.fn(), member: vi.fn(), upsert: vi.fn(), update: vi.fn(), enqueue: vi.fn(), gate: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { $transaction: f.transaction,
  studioGenerationOutput: { findMany: f.outputs }, studioGeneratedMaterial: { findMany: f.artifacts }, project: { findFirst: f.project } } }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts-queue", () => ({ enqueueStudioArtifact: f.enqueue }));
import { ensureStudioGenerationArtifacts, readStudioGenerationResults, requireArtifactWrite, retryStudioGenerationArtifacts } from "../../../apps/web/src/lib/studio-generation-artifacts";

let request: any, outputs: any[], recoverable: any[], artifacts: any[], tx: any;
const future = () => new Date(Date.now() + 86_400_000);
const ready = () => ({ outputId: "output", versionId: "version", assetId: "asset", status: "SUCCEEDED", expiresAt: future(), sha256: "a".repeat(64), width: 48, height: 32, mimeType: "image/png",
  asset: { id: "asset", workspaceId: "w", deprecatedAt: null, availableForGeneration: true, generationVersionId: "version", projectLinks: [{ id: "link" }] }, version: { generationId: "generation" } });
beforeEach(() => {
  vi.resetAllMocks();
  request = { id: "request", workspaceId: "w", projectId: "p", userId: "u", generationId: "generation", status: "SUCCEEDED", generation: { workspaceId: "w", projectId: "p" }, outputs: [] };
  outputs = [{ id: "output", expiresAt: future() }]; recoverable = outputs; artifacts = [];
  f.outputs.mockImplementation(async ({ where }) => where.imageUrl ? recoverable : outputs);
  f.artifacts.mockImplementation(async () => artifacts); f.project.mockResolvedValue({ archivedAt: null });
  f.request.mockImplementation(async () => request); f.ownedRequest.mockImplementation(async () => ({ ...request, outputs: recoverable }));
  f.query.mockResolvedValue([{ archivedAt: null }]); f.workspace.mockResolvedValue({ ownerId: "u" });
  f.upsert.mockImplementation(async ({ create }) => ({ ...create, status: "PENDING" })); f.enqueue.mockResolvedValue(true);
  tx = { $queryRaw: f.query, project: { findFirst: f.project }, brandWorkspace: { findUnique: f.workspace }, membership: { findUnique: f.member },
    studioGenerationRequest: { findUnique: f.request, findFirst: f.ownedRequest }, studioGenerationOutput: { findMany: f.outputs }, studioGeneratedMaterial: { findMany: f.artifacts, upsert: f.upsert, updateMany: f.update } };
  f.transaction.mockImplementation(fn => fn(tx));
});

describe("durable archive receipt and retry boundaries (unit DB fixtures)", () => {
  it("keeps generation success separate from pending or failed archive and never projects private source URLs", async () => {
    expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "PENDING", results: [], canRetryArchive: false });
    artifacts = [{ outputId: "output", status: "FAILED", error: "private provider URL", expiresAt: future() }];
    const view = await readStudioGenerationResults(request);
    expect(view).toMatchObject({ resultState: "FAILED", results: [], canRetryArchive: true });
    expect(JSON.stringify(view)).not.toContain("private provider URL");
    expect(f.outputs.mock.calls.every(([args]) => args.select.imageUrl !== true)).toBe(true);
  });
  it("returns only actual archived dimensions/hash and canonical authenticated asset URLs", async () => {
    artifacts = [ready()]; recoverable = [];
    expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "READY", canRetryArchive: false, archiveError: null,
      results: [{ versionId: "version", assetId: "asset", assetSha256: "a".repeat(64), width: 48, height: 32, mimeType: "image/png", url: "/api/workspaces/w/assets/asset/raw" }] });
    for (const mutation of [
      (r: any) => { r.asset.projectLinks = []; },
      (r: any) => { r.asset.workspaceId = "other"; },
      (r: any) => { r.asset.deprecatedAt = new Date(); },
      (r: any) => { r.asset.availableForGeneration = false; },
      (r: any) => { r.asset.generationVersionId = "different"; },
      (r: any) => { r.version.generationId = "different"; },
      (r: any) => { r.sha256 = "guess"; },
    ]) { artifacts = [ready()]; mutation(artifacts[0]); expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "FAILED", results: [], canRetryArchive: false }); }
  });
  it("reports independent attempt and private-output expiry, and cannot retry discarded raw bytes", async () => {
    const attemptDeadline = new Date(Date.now() + 60000);
    artifacts = [{ outputId: "output", status: "RUNNING", expiresAt: attemptDeadline }];
    expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "RUNNING", archiveProcessingExpiresAt: attemptDeadline.toISOString(), archiveExpiresAt: outputs[0].expiresAt.toISOString() });
    artifacts[0].expiresAt = new Date(Date.now() - 1);
    expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "FAILED", canRetryArchive: true, archiveProcessingExpiresAt: null });
    outputs[0].expiresAt = new Date(Date.now() - 1); recoverable = [];
    expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "FAILED", canRetryArchive: false, archiveError: expect.stringContaining("恢复期限") });
  });
  it("shows unavailable success without an output as failure and never permits archived-project retry", async () => {
    outputs = []; recoverable = [];
    expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "FAILED", canRetryArchive: false });
    request.status = "RUNNING"; expect(await readStudioGenerationResults(request)).toMatchObject({ resultState: "NOT_REQUESTED" });
    outputs = [{ id: "output", expiresAt: future() }]; recoverable = outputs; artifacts = [{ outputId: "output", status: "FAILED", expiresAt: future() }]; f.project.mockResolvedValue({ archivedAt: new Date() });
    expect((await readStudioGenerationResults(request)).canRetryArchive).toBe(false);
    artifacts = []; expect((await readStudioGenerationResults(request)).resultState).toBe("FAILED");
  });
  it("creates the DB outbox before bounded enqueue and remains recoverable while Redis is down", async () => {
    f.enqueue.mockResolvedValue(false);
    await ensureStudioGenerationArtifacts("request");
    expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { outputId: "output" }, update: {}, create: expect.objectContaining({ requestId: "request", workspaceId: "w", projectId: "p", userId: "u", objectKey: "w/studio-generated/p/output" }) }));
    expect(f.enqueue.mock.invocationCallOrder[0]).toBeGreaterThan(f.upsert.mock.invocationCallOrder[0]);
    expect(f.enqueue).toHaveBeenCalledWith("output", expect.any(Date));
  });
  it("does not reset failed/successful artifacts implicitly or enqueue foreign/unfinished generation rows", async () => {
    f.upsert.mockResolvedValue({ status: "FAILED", expiresAt: future() }); await ensureStudioGenerationArtifacts("request"); expect(f.enqueue).not.toHaveBeenCalled();
    request.status = "RUNNING"; f.upsert.mockClear(); await ensureStudioGenerationArtifacts("request"); expect(f.upsert).not.toHaveBeenCalled();
    request.status = "SUCCEEDED"; request.generation.workspaceId = "other"; await ensureStudioGenerationArtifacts("request"); expect(f.upsert).not.toHaveBeenCalled();
  });
  it("gates retry before DB access and scopes it to the submitting member, project and workspace", async () => {
    f.gate.mockRejectedValueOnce({ status: 403 });
    await expect(retryStudioGenerationArtifacts("w", "viewer", { projectId: "p", requestId: "request" })).rejects.toMatchObject({ status: 403 }); expect(f.transaction).not.toHaveBeenCalled();
    f.ownedRequest.mockResolvedValueOnce(null);
    await expect(retryStudioGenerationArtifacts("w", "u", { projectId: "p", requestId: "other" })).rejects.toMatchObject({ status: 404 });
    expect(f.ownedRequest).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other", workspaceId: "w", projectId: "p", userId: "u" } }));
  });
  it("retries archive only and resets exclusively failed/expired claims without refreshing source retention", async () => {
    await retryStudioGenerationArtifacts("w", "u", { projectId: "p", requestId: "request" });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "EDITOR");
    expect(f.update.mock.calls[0][0]).toMatchObject({ where: { outputId: "output", requestId: "request", OR: [{ status: "FAILED" }, { status: { in: ["PENDING", "RUNNING"] }, expiresAt: { lte: expect.any(Date) } }] }, data: { status: "PENDING", error: null, attemptToken: null, startedAt: null } });
    expect(f.update.mock.calls[0][0].data.expiresAt.getTime()).toBeLessThan(outputs[0].expiresAt.getTime());
    expect(f.upsert).toHaveBeenCalled(); expect(f.enqueue).toHaveBeenCalled();
  });
  it("refuses expired raw results and unsupported client retry fields", async () => {
    recoverable = [];
    await expect(retryStudioGenerationArtifacts("w", "u", { projectId: "p", requestId: "request" })).rejects.toMatchObject({ status: 409 });
    await expect(retryStudioGenerationArtifacts("w", "u", { projectId: "p", requestId: "request", provider: "mock" })).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("enforces current project archive and writer membership within publication transactions", async () => {
    await requireArtifactWrite(tx, "w", "p", "u"); expect(f.query.mock.calls[0][0].join("")).toContain("FOR UPDATE");
    f.query.mockResolvedValueOnce([]); await expect(requireArtifactWrite(tx, "w", "p", "u")).rejects.toMatchObject({ status: 409 });
    f.query.mockResolvedValueOnce([{ archivedAt: new Date() }]); await expect(requireArtifactWrite(tx, "w", "p", "u")).rejects.toMatchObject({ status: 409 });
    f.workspace.mockResolvedValue({ ownerId: "other" }); f.member.mockResolvedValue({ role: "VIEWER" });
    await expect(requireArtifactWrite(tx, "w", "p", "u")).rejects.toMatchObject({ status: 403 });
    f.member.mockResolvedValue({ role: "EDITOR" }); await expect(requireArtifactWrite(tx, "w", "p", "u")).resolves.toBeUndefined();
  });
});
