import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), gate: vi.fn(), read: vi.fn(), update: vi.fn(), updateMany: vi.fn(), output: vi.fn(), clearOutputs: vi.fn(), pending: vi.fn(), missing: vi.fn(), ensure: vi.fn(), enqueue: vi.fn(), settings: vi.fn(), bytes: vi.fn(), inspect: vi.fn(), process: vi.fn(), upload: vi.fn(), priorAsset: vi.fn(), logo: vi.fn(), asset: vi.fn(), version: vi.fn(), existingVersion: vi.fn(), link: vi.fn() }));
vi.mock("../../db/src/index", () => ({ Prisma: {}, prisma: { $transaction: f.transaction,
  studioGeneratedMaterial: { updateMany: f.updateMany, findMany: f.pending }, studioGenerationOutput: { updateMany: f.clearOutputs }, studioGenerationRequest: { findMany: f.missing }, asset: { findUnique: f.priorAsset, findFirst: f.logo } } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/s3", () => ({ uploadBuffer: f.upload }));
vi.mock("@/lib/settings", () => ({ getEffectiveStorage: f.settings }));
vi.mock("@/lib/asset-mirror", () => ({ assetCategoryForScene: () => "SOCIAL" }));
vi.mock("@/lib/studio-generation-artifacts-image", () => ({ artifactDeadline: async (work: Promise<any>) => work,
  artifactOwnObjectKey: () => null, readArtifactImageBytes: f.bytes, inspectArtifactImage: f.inspect, postprocessArtifactImage: f.process }));
vi.mock("@/lib/studio-generation-artifacts-queue", () => ({ enqueueStudioArtifact: f.enqueue }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ ensureStudioGenerationArtifacts: f.ensure, requireArtifactWrite: f.gate,
  STUDIO_ARTIFACT_ERROR: "Archive failed; retry archive only", STUDIO_ARTIFACT_EXPIRED: "Raw recovery expired", STUDIO_ARTIFACT_RUN_MS: 60_000 }));
import { runStudioGenerationArtifactJob, sweepStudioGenerationArtifacts } from "../../../apps/web/src/lib/workers/studio-generation-artifacts.worker";
import { ApiException } from "@/lib/api";

let row: any, tx: any;
const bytes = Buffer.from("unit image fixture; decoder mocked here"), sha = "a".repeat(64);
const job = (attemptsMade = 0) => ({ data: { outputId: "output", epoch: row.expiresAt.getTime() }, attemptsMade, opts: { attempts: 3 } } as any);
beforeEach(() => {
  vi.resetAllMocks();
  row = { outputId: "output", requestId: "request", workspaceId: "w", projectId: "p", userId: "u", versionId: null, status: "PENDING", attemptToken: null, expiresAt: new Date(Date.now() + 300_000),
    output: { id: "output", requestId: "request", workspaceId: "w", projectId: "p", imageUrl: "data:image/png;base64,AAAA", expiresAt: new Date(Date.now() + 86_400_000), index: 0, params: { studioPostprocess: { watermarkOverlays: [], automaticBrandLogoAssetId: null }, studioSourceRetention: "bytes", appliedRuleIds: ["rule"] } },
    request: { id: "request", status: "SUCCEEDED", workspaceId: "w", projectId: "p", userId: "u", generationId: "generation", generation: { workspaceId: "w", projectId: "p", sceneType: "SOCIAL_POSTER" } } };
  tx = { $queryRaw: f.query, studioGeneratedMaterial: { findUnique: f.read, update: f.update }, studioGenerationOutput: { update: f.output },
    generationVersion: { findUnique: f.existingVersion, upsert: f.version }, asset: { findUnique: f.priorAsset, upsert: f.asset }, projectAsset: { upsert: f.link } };
  f.transaction.mockImplementation(fn => fn(tx)); f.read.mockImplementation(async () => structuredClone(row));
  f.update.mockImplementation(async ({ data }) => { Object.assign(row, data); return row; });
  f.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.attemptToken && (where.attemptToken !== row.attemptToken || row.status !== where.status)) return { count: 0 };
    Object.assign(row, data); return { count: 1 };
  });
  f.output.mockImplementation(async ({ data }) => { Object.assign(row.output, data); return row.output; });
  f.settings.mockResolvedValue({ configured: true, publicUrl: "http://private.invalid/bucket" }); f.bytes.mockResolvedValue(bytes);
  f.inspect.mockResolvedValue({ mimeType: "image/png", width: 48, height: 32, sizeBytes: bytes.length, sha256: sha });
  f.process.mockResolvedValue({ body: bytes, mimeType: "image/png", width: 48, height: 32, sizeBytes: bytes.length, sha256: sha, appliedAssetIds: [] });
  f.upload.mockImplementation(async (_b, _m, _p, _s, key) => ({ key, url: `http://private.invalid/bucket/${key}` }));
  f.asset.mockResolvedValue({ id: "asset" }); f.priorAsset.mockResolvedValue(null); f.existingVersion.mockResolvedValue(null);
  f.pending.mockResolvedValue([]); f.missing.mockResolvedValue([]);
});

describe("generation archive worker (unit fixtures; no provider or remote storage)", () => {
  it("publishes a real version/asset/project link only after complete archive and clears private bytes", async () => {
    await runStudioGenerationArtifactJob(job());
    expect(row.status).toBe("SUCCEEDED"); expect(row.sha256).toBe(sha); expect(row.output.imageUrl).toBeNull();
    expect(row.versionId).toMatch(/^sgv_/); expect(row.assetId).toBe("asset");
    expect(f.upload).toHaveBeenCalledWith(bytes, "image/png", "w/studio-generated/p", expect.any(AbortSignal), `w/studio-generated/p/output/${sha}`);
    expect(f.version.mock.calls[0][0].create).toMatchObject({ generationId: "generation", width: 48, height: 32, params: { appliedRuleIds: ["rule"] } });
    expect(f.version.mock.calls[0][0].create.params).not.toHaveProperty("studioPostprocess");
    expect(f.link.mock.calls[0][0].create).toMatchObject({ projectId: "p", assetId: "asset", kind: "MEMBER" });
    expect(f.gate).toHaveBeenCalledTimes(2);
    await runStudioGenerationArtifactJob(job()); expect(f.upload).toHaveBeenCalledTimes(1); expect(f.asset).toHaveBeenCalledTimes(1);
  });
  it("completes existing mirror metadata without duplicating the version asset or project link", async () => {
    row.versionId = "existing-version"; row.output.imageUrl = "http://private.invalid/mirrored";
    f.existingVersion.mockResolvedValue({ generationId: "generation" });
    f.priorAsset.mockResolvedValue({ id: "asset", workspaceId: "w", storageKey: "w/prior", url: row.output.imageUrl, deprecatedAt: null, availableForGeneration: true });
    await runStudioGenerationArtifactJob(job());
    expect(f.bytes.mock.calls[0][0]).toMatchObject({ objectKey: "w/prior" });
    expect(f.asset.mock.calls[0][0]).toMatchObject({ where: { generationVersionId: "existing-version" }, update: { sizeBytes: bytes.length, mimeType: "image/png", resolution: "48 × 32" } });
    expect(row.versionId).toBe("existing-version");
  });
  it("retains paid provider bytes and does not publish a version when composition fails", async () => {
    f.process.mockRejectedValue(new ApiException(422, "failed logo contains private details"));
    await runStudioGenerationArtifactJob(job());
    expect(row.status).toBe("FAILED"); expect(row.output.imageUrl).not.toBeNull();
    expect(row.error).not.toContain("private details"); expect(f.version).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
  });
  it("materializes external URL bytes privately before a later storage failure", async () => {
    row.output.imageUrl = "https://provider.invalid/temporary"; row.output.params.studioSourceRetention = "upstream-url";
    f.upload.mockRejectedValue(new Error("S3 secret detail"));
    await runStudioGenerationArtifactJob(job(2));
    expect(row.status).toBe("FAILED"); expect(row.output.imageUrl).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(row.output.params.studioSourceRetention).toBe("bytes"); expect(f.version).not.toHaveBeenCalled();
  });
  it("preserves bytes for automatic transient retries without provider calls or terminal fake success", async () => {
    f.upload.mockRejectedValue(new Error("S3 unavailable"));
    await expect(runStudioGenerationArtifactJob(job())).rejects.toThrow("temporarily unavailable");
    expect(row.status).toBe("PENDING"); expect(row.output.imageUrl).not.toBeNull();
    await runStudioGenerationArtifactJob(job(2)); expect(row.status).toBe("FAILED"); expect(f.version).not.toHaveBeenCalled();
  });
  it("fails closed for changed ownership/archived project before storage and rechecks after it", async () => {
    f.gate.mockRejectedValueOnce(new ApiException(403, "role revoked"));
    await runStudioGenerationArtifactJob(job()); expect(row.status).toBe("FAILED"); expect(f.upload).not.toHaveBeenCalled();
    row.status = "PENDING"; f.gate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiException(409, "archived during I/O"));
    await runStudioGenerationArtifactJob(job()); expect(row.status).toBe("FAILED"); expect(f.version).not.toHaveBeenCalled();
  });
  it("does not let a stale queue epoch or active DB claim consume the source twice", async () => {
    const obsolete = job(); obsolete.data.epoch--;
    await runStudioGenerationArtifactJob(obsolete); expect(f.bytes).not.toHaveBeenCalled();
    row.status = "RUNNING"; row.startedAt = new Date(); row.attemptToken = "active";
    await runStudioGenerationArtifactJob(job()); expect(row.attemptToken).toBe("active"); expect(f.bytes).not.toHaveBeenCalled();
  });
  it("expires jobs and refuses malformed tenant references before any external IO", async () => {
    row.expiresAt = new Date(Date.now() - 1); await runStudioGenerationArtifactJob(job()); expect(row.status).toBe("FAILED");
    row.status = "PENDING"; row.expiresAt = new Date(Date.now() + 50000); row.request.workspaceId = "other";
    await runStudioGenerationArtifactJob(job()); expect(row.status).toBe("FAILED"); expect(f.upload).not.toHaveBeenCalled(); expect(f.bytes).not.toHaveBeenCalled();
  });
  it("prevents late claims from publishing or clearing another worker's source", async () => {
    f.upload.mockImplementation(async () => { row.attemptToken = "new-claim"; return { key: "key", url: "http://object.invalid/winner" }; });
    await runStudioGenerationArtifactJob(job());
    expect(row.attemptToken).toBe("new-claim"); expect(row.status).toBe("RUNNING"); expect(row.output.imageUrl).not.toBeNull(); expect(f.version).not.toHaveBeenCalled();
  });
  it("does not turn an uncertain DB reply after commit into failure or delete the winner", async () => {
    let calls = 0;
    f.transaction.mockImplementation(async fn => { const result = await fn(tx); if (++calls === 3) throw new Error("reply lost after commit"); return result; });
    await runStudioGenerationArtifactJob(job());
    expect(row.status).toBe("SUCCEEDED"); expect(row.output.imageUrl).toBeNull(); expect(row.assetId).toBe("asset");
  });
  it("refuses incomplete required logo application and deactivated preexisting assets", async () => {
    row.output.params.studioPostprocess.automaticBrandLogoAssetId = "logo";
    await runStudioGenerationArtifactJob(job()); expect(row.status).toBe("FAILED"); expect(f.upload).not.toHaveBeenCalled();
    row.status = "PENDING"; row.output.params.studioPostprocess.automaticBrandLogoAssetId = null;
    f.priorAsset.mockResolvedValue({ workspaceId: "w", deprecatedAt: new Date(), availableForGeneration: false });
    await runStudioGenerationArtifactJob(job()); expect(row.status).toBe("FAILED"); expect(f.asset).not.toHaveBeenCalled();
  });
  it("recovers missing outboxes, expires private outputs and redelivers pending DB jobs", async () => {
    f.missing.mockResolvedValue([{ id: "missing" }]); f.pending.mockResolvedValue([{ outputId: "waiting", expiresAt: row.expiresAt }]);
    await sweepStudioGenerationArtifacts();
    expect(f.ensure).toHaveBeenCalledWith("missing"); expect(f.enqueue).toHaveBeenCalledWith("waiting", row.expiresAt);
    expect(f.clearOutputs.mock.calls[0][0]).toMatchObject({ where: { imageUrl: { not: null }, expiresAt: { lte: expect.any(Date) } }, data: { imageUrl: null } });
    expect(f.updateMany.mock.calls[1][0].data).toEqual({ status: "PENDING", attemptToken: null });
  });
});
