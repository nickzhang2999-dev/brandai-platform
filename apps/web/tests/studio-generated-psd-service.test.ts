import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ generation: vi.fn(), first: vi.fn(), many: vi.fn(), update: vi.fn(), material: vi.fn(), findDecomp: vi.fn(), tx: vi.fn(), lock: vi.fn(), role: vi.fn(), project: vi.fn(), submit: vi.fn(), readDecomp: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ Prisma: {}, prisma: { $transaction: f.tx,
  studioGenerationRequest: { findUnique: f.generation, findFirst: f.first, findMany: f.many, update: f.update },
  studioGeneratedMaterial: { findFirst: f.material }, studioDecompositionRequest: { findUnique: f.findDecomp }, project: { findFirst: f.project },
} }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("../src/lib/studio-decomposition", () => ({ submitGeneratedStudioDecomposition: f.submit, readStudioDecompositions: f.readDecomp }));
import { ApiException } from "../src/lib/api";
import { registerStudioGeneratedPsd, dispatchStudioGeneratedPsds, readStudioGeneratedPsd } from "../src/lib/studio-generated-psd";
import { generatedPsdIntent } from "../src/lib/studio-generated-psd-state";
import { newStudioLayerPlanning } from "../src/lib/studio-decomposition-planning";

let row: any;
const layers = [0, 1].map(order => ({ assetId: `layer${order}`, assetSha256: "a".repeat(64), mimeType: "image/png", width: 8, height: 8, order, sizeBytes: 30,
  url: `/api/workspaces/w/assets/layer${order}/raw`, alphaBounds: { left: 0, top: 0, width: 8, height: 8 }, inkCoverage: .5 }));
const decomp = (status = "SUCCEEDED") => ({ requestId: "d", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", projectId: "p", sourceShapeId: "shape:generated", assetId: "source", assetSha256: "b".repeat(64), documentRevision: 0, layerCount: 2, sourceWidth: 8, sourceHeight: 8, status, error: status === "FAILED" ? "分层服务未配置" : null,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 360000).toISOString(), archiveExpiresAt: null, canRetryArchive: false, layers: status === "SUCCEEDED" ? layers : [] });
beforeEach(() => {
  vi.resetAllMocks();
  row = { id: "r", workspaceId: "w", userId: "u", projectId: "p", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", createdAt: new Date(), status: "SUCCEEDED", jobData: { generationId: "g", ...generatedPsdIntent(2) } };
  f.generation.mockImplementation(async () => row);
  f.first.mockImplementation(async ({ where }) => where.id === row.id && where.workspaceId === row.workspaceId && where.userId === row.userId && where.projectId === row.projectId ? row : null);
  f.material.mockResolvedValue({ status: "SUCCEEDED" }); f.findDecomp.mockResolvedValue(null); f.many.mockResolvedValue([{ id: "r" }]);
  f.role.mockResolvedValue({ role: "EDITOR" }); f.project.mockResolvedValue({ id: "p" }); f.submit.mockResolvedValue(decomp("PENDING")); f.readDecomp.mockResolvedValue(decomp());
  f.update.mockImplementation(async ({ data }) => { row.jobData = data.jobData; return row; });
  f.tx.mockImplementation(async fn => fn({ $queryRaw: f.lock, studioGenerationRequest: { findUnique: f.generation, update: f.update } }));
});

describe("automatic PSD durable outbox, simulated persistence and no paid model", () => {
  it("persists AUTO intent without a browser count and registers only through the worker outbox", async () => {
    row.jobData = { generationId: "g", ...generatedPsdIntent(undefined, "AUTO") };
    f.submit.mockResolvedValue({ ...decomp("PENDING"), layerMode: "AUTO", analysisStatus: "PENDING", analysisSummary: null });
    expect(await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" })).toMatchObject({ requested: true, status: "PENDING" });
    expect(f.submit).not.toHaveBeenCalled();
    await registerStudioGeneratedPsd("r"); await registerStudioGeneratedPsd("r");
    expect(f.submit).toHaveBeenCalledOnce(); expect(row.jobData.studioPsdLayerMode).toBe("AUTO");
    expect(row.jobData).not.toHaveProperty("studioPsdLayerCount"); expect(row.jobData.studioGeneratedPsd.status).toBe("REGISTERED");
  });
  it("recovers an existing AUTO identity with any server-resolved count after a crash", async () => {
    row.createdAt = new Date(0); row.jobData = { generationId: "g", ...generatedPsdIntent(undefined, "AUTO") };
    f.findDecomp.mockResolvedValue({ id: "d", layerCount: 7, planningJson: newStudioLayerPlanning("AUTO") });
    await registerStudioGeneratedPsd("r");
    expect(f.submit).not.toHaveBeenCalled(); expect(row.jobData.studioGeneratedPsd).toMatchObject({ status: "REGISTERED", decompositionRequestId: "d" });
  });
  it("ordinary generation/read performs zero submission, updates and queue activity", async () => {
    row.jobData = { generationId: "g" };
    await registerStudioGeneratedPsd("r");
    expect(await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" })).toMatchObject({ requested: false, status: "NOT_REQUESTED", downloadUrl: null });
    expect(f.submit).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it("does not dispatch before the real original asset has successfully archived", async () => {
    row.status = "RUNNING"; await registerStudioGeneratedPsd("r"); expect(f.material).not.toHaveBeenCalled();
    row.status = "SUCCEEDED"; f.material.mockResolvedValue({ status: "RUNNING" }); await registerStudioGeneratedPsd("r");
    expect(f.submit).not.toHaveBeenCalled(); expect(row.jobData.studioGeneratedPsd.status).toBe("PENDING");
  });
  it("registers exactly once and exposes READY only for persisted transparent layer receipts", async () => {
    await registerStudioGeneratedPsd("r"); await registerStudioGeneratedPsd("r");
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledWith("r"); expect(row.jobData.studioPsdLayerCount).toBe(2);
    expect(row.jobData.studioGeneratedPsd).toEqual({ status: "REGISTERED", decompositionRequestId: "d", error: null });
    expect(await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" })).toMatchObject({ status: "READY", downloadUrl: "/api/workspaces/w/studio/decomposition/d/export?projectId=p&format=psd" });
  });
  it("refreshes a configuration failure without mutating or invalidating the original generated result", async () => {
    await registerStudioGeneratedPsd("r"); f.readDecomp.mockResolvedValue(decomp("FAILED"));
    const first = await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" });
    const refreshed = await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" });
    expect(first).toEqual(refreshed); expect(first).toMatchObject({ status: "FAILED", error: "分层服务未配置", downloadUrl: null });
    expect(row.status).toBe("SUCCEEDED"); expect(f.submit).toHaveBeenCalledOnce();
  });
  it("recovers a committed decomposition after a crash without paying/submitting again, even after TTL", async () => {
    row.createdAt = new Date(0); f.findDecomp.mockResolvedValue({ id: "d", layerCount: 2 });
    await registerStudioGeneratedPsd("r");
    expect(row.jobData.studioGeneratedPsd.status).toBe("REGISTERED"); expect(f.submit).not.toHaveBeenCalled(); expect(f.material).not.toHaveBeenCalled();
  });
  it("GET is strictly read-only with no lazy submission or recovery when the worker is not running", async () => {
    expect(await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" })).toMatchObject({ status: "PENDING" });
    expect(f.submit).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.material).not.toHaveBeenCalled(); expect(f.findDecomp).not.toHaveBeenCalled();
  });
  it.each([["other", "u", "p"], ["w", "other", "p"], ["w", "u", "other"]])("denies cross workspace/actor/project reads %s %s %s", async (ws, actor, project) => {
    await expect(readStudioGeneratedPsd(ws, actor, { projectId: project, requestId: "r" })).rejects.toMatchObject({ status: 404 });
    expect(f.readDecomp).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it("leaves transient capacity and DB errors recoverable under the same stable intake identity", async () => {
    f.submit.mockRejectedValueOnce(new ApiException(429, "busy")); await registerStudioGeneratedPsd("r");
    expect(row.jobData.studioGeneratedPsd.status).toBe("PENDING");
    f.submit.mockRejectedValueOnce(new Error("synthetic DB disconnect")); await registerStudioGeneratedPsd("r");
    expect(row.jobData.studioGeneratedPsd.status).toBe("PENDING");
    await registerStudioGeneratedPsd("r"); expect(row.jobData.studioGeneratedPsd.status).toBe("REGISTERED");
  });
  it("configuration failures are reported as service availability, never disguised as EXACT source protection", async () => {
    row.jobData = { generationId: "g", ...generatedPsdIntent(undefined, "AUTO") };
    f.submit.mockRejectedValue(new ApiException(503, "fixture unavailable")); await registerStudioGeneratedPsd("r");
    expect(row.jobData.studioGeneratedPsd.error).toContain("尚未配置"); expect(row.jobData.studioGeneratedPsd.error).not.toContain("严格保留素材");
    expect(row.status).toBe("SUCCEEDED");
  });
  it.each([403, 404, 409, 422])("terminalizes safety denial %i while retaining original generation and immutable selection", async status => {
    f.submit.mockRejectedValue(new ApiException(status, "synthetic reject")); await registerStudioGeneratedPsd("r"); await registerStudioGeneratedPsd("r");
    expect(row.jobData.studioGeneratedPsd.status).toBe("FAILED"); expect(row.jobData.studioPsdLayerCount).toBe(2); expect(row.status).toBe("SUCCEEDED"); expect(f.submit).toHaveBeenCalledOnce();
    expect(await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" })).toMatchObject({ status: "FAILED", downloadUrl: null });
  });
  it("declines a PSD budget before exposing a download even if layers are already published", async () => {
    await registerStudioGeneratedPsd("r"); const value = decomp(); value.sourceWidth = value.sourceHeight = 16384;
    value.layers = value.layers.map(layer => ({ ...layer, width: 16384, height: 16384 })); f.readDecomp.mockResolvedValue(value);
    expect(await readStudioGeneratedPsd("w", "u", { projectId: "p", requestId: "r" })).toMatchObject({ status: "FAILED", downloadUrl: null, error: expect.stringContaining("内存预算") });
  });
  it("expires an unregistered intent without another provider call and scans only bounded terminal outboxes", async () => {
    row.createdAt = new Date(0); await dispatchStudioGeneratedPsds();
    expect(row.jobData.studioGeneratedPsd.status).toBe("FAILED"); expect(f.submit).not.toHaveBeenCalled();
    expect(f.many).toHaveBeenCalledWith({ where: { status: { in: ["SUCCEEDED", "FAILED"] }, jobData: { path: ["studioGeneratedPsd", "status"], equals: "PENDING" } }, select: { id: true }, take: 32, orderBy: { createdAt: "asc" } });
  });
});
