import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ request: vi.fn(), claim: vi.fn(), ready: vi.fn(), finish: vi.fn(), stage: vi.fn(), archive: vi.fn(), exact: vi.fn(), refs: vi.fn(), rules: vi.fn(), precheck: vi.fn(), generate: vi.fn(), generation: vi.fn(), update: vi.fn(), assets: vi.fn(), roots: vi.fn(), usage: vi.fn(), settings: vi.fn(), editSource: vi.fn(), edit: vi.fn(), editGuard: vi.fn(), brandPolicy: vi.fn() }));
vi.mock("../../db/src/index", () => ({ Prisma: {}, prisma: {
  studioGenerationRequest: { findUnique: f.request }, generation: { findUnique: f.generation, update: f.update },
  brandWorkspace: { findUnique: async () => ({ ownerId: "u" }) }, prohibitionRule: { findMany: async () => [] },
  asset: { findMany: f.assets }, generationVersion: { findMany: f.roots },
} }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/studio-generation-lifecycle", () => ({ claimStudioGeneration: f.claim, assertStudioGenerationReady: f.ready, finishStudioGeneration: f.finish, stageStudioGenerationOutput: f.stage }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ ensureStudioGenerationArtifacts: f.archive }));
vi.mock("@/lib/studio-generation-exact", () => ({ studioExactIntent: () => ({ layout: null, modelExpected: {} }), preflightStudioExactSources: f.exact, assertStudioExactNotModelInput: vi.fn() }));
vi.mock("@/lib/studio-generation-references", () => ({ inlineStudioGenerationReferences: f.refs, studioProviderParams: () => ({}) }));
vi.mock("@/lib/ai", () => ({ ai: { generate: f.generate, studioEdit: f.edit } }));
vi.mock("@/lib/studio-generation-edit", () => ({ loadStudioEditSource: f.editSource, assertStudioEditNotModelReference: f.editGuard }));
vi.mock("@/lib/studio-generation-base", () => ({ requireStudioBaseEncryption: vi.fn() }));
vi.mock("@/lib/s3", () => ({ uploadDataUrlImage: vi.fn() }));
vi.mock("@/lib/asset-mirror", () => ({ mirrorGenerationVersionToAsset: vi.fn() }));
vi.mock("@/lib/watermark", () => ({ applyWatermarksToImage: vi.fn() }));
vi.mock("@/lib/rules", () => ({ getConfirmedRules: f.rules }));
vi.mock("@/lib/precheck", () => ({ runPrecheck: f.precheck }));
vi.mock("@/lib/prohibitions", () => ({ loadAssetUrlMap: async () => new Map(), loadProhibitionReferenceImages: vi.fn(), serializeProhibition: vi.fn() }));
vi.mock("@/lib/compliance", () => ({ loadTermLib: vi.fn() }));
vi.mock("@/lib/generations", () => ({ setVersionComplianceReport: vi.fn() }));
vi.mock("@/lib/ai-constraints", () => ({ constraintsEnabled: () => true, compileAIConstraints: () => ({ blockers: [], aiConstraints: { promptAdditions: [], negativePrompt: [], hardBlocks: [], referenceImages: [] } }) }));
vi.mock("@/lib/usage", () => ({ recordUsage: f.usage, fromGenerateUsage: () => ({}) }));
vi.mock("@/lib/settings", () => ({ getEffectiveAiSettings: f.settings }));
vi.mock("@/lib/chat-brand-policy", () => ({ resolveChatBrandPolicy: f.brandPolicy }));
vi.mock("@/lib/exact-assets", () => ({ applyExactAssetLayers: vi.fn() }));
import { runGenerateJob } from "../../../apps/web/src/lib/workers/generate.worker";

let row: any, events: string[];
const conflict = () => Object.assign(new Error("Brand rules changed before dispatch"), { status: 409 });
const job = () => ({ data: { ...row.jobData }, updateProgress: vi.fn().mockResolvedValue(undefined) } as any);
beforeEach(() => {
  vi.resetAllMocks(); events = [];
  row = { id: "request", workspaceId: "w", projectId: "p", userId: "u", generationId: "g", status: "RUNNING", providerStartedAt: new Date(), expiresAt: new Date(Date.now() + 60000),
    jobData: { generationId: "g", workspaceId: "w", versionCount: 1, targets: [{ key: "square", label: "Square", width: 1024, height: 1024 }] } };
  f.request.mockImplementation(async () => row); f.claim.mockImplementation(async () => row);
  f.generation.mockResolvedValue({ id: "g", projectId: "p", workspaceId: "w", sceneType: "SOCIAL_POSTER", sellingPoint: "Poster", scene: "", chatContext: null });
  f.exact.mockImplementation(async () => { events.push("sources"); });
  f.rules.mockImplementation(async () => { events.push("rules"); return []; });
  f.refs.mockImplementation(async () => { events.push("references"); return { references: [], audit: [] }; });
  f.ready.mockImplementation(async () => { events.push("ready"); });
  f.precheck.mockImplementation(async () => { events.push("precheck"); return { blocking: false }; });
  f.generate.mockImplementation(async () => { events.push("provider"); return { versions: [{ imageUrl: "data:image/png;base64,YQ==", width: 1024, height: 1024, params: {} }] }; });
  f.stage.mockImplementation(async () => { events.push("stage"); return "output"; });
  f.finish.mockImplementation(async (_row, status) => { events.push(`finish:${status}`); return true; });
  f.archive.mockImplementation(async () => { events.push("archive"); });
  f.assets.mockResolvedValue([]); f.roots.mockResolvedValue([]); f.settings.mockResolvedValue({});
  f.brandPolicy.mockImplementation(({ brandRules, aiConstraints }: any) => ({ brandRules, aiConstraints }));
});

describe("real generation worker pre-provider ordering (isolated dependencies)", () => {
  it("dispatches a saved edit through the image-edit service once, preserves its source recipe privately and never calls text generation", async () => {
    row.jobData.studioEdit = { assetId: "source", sha256: "a".repeat(64), shapeId: "shape:source", width: 48, height: 32, recipeHash: "b".repeat(64) };
    f.editSource.mockResolvedValue({ imageUrl: "data:image/png;base64,YQ==" });
    f.edit.mockResolvedValue({ versions: [{ imageUrl: "data:image/png;base64,Yg==", width: 1024, height: 1024, params: {} }] });
    await runGenerateJob(job());
    expect(f.editSource).toHaveBeenCalledWith("w", "p", row.jobData.studioEdit, expect.any(AbortSignal));
    expect(f.edit).toHaveBeenCalledOnce(); expect(f.generate).not.toHaveBeenCalled();
    expect(f.editGuard).toHaveBeenCalledWith(row.jobData.studioEdit, null, []);
    expect(f.brandPolicy).toHaveBeenCalledWith(expect.objectContaining({ preserveCompiledConstraints: true }));
    expect(f.edit.mock.calls[0][0]).toMatchObject({ imageUrl: "data:image/png;base64,YQ==", generation: { providerRetryPolicy: "never", targets: row.jobData.targets, versionCount: 1 } });
    expect(f.stage.mock.calls[0][1].params).toMatchObject({ imageKind: "EDITED", studioPostprocess: { editSource: row.jobData.studioEdit } });
  });
  it("blocks a flattened protected target in the final reference audit before any provider request", async () => {
    row.jobData.studioEdit = { assetId: "source" };
    f.editSource.mockResolvedValue({ imageUrl: "data:image/png;base64,YQ==" });
    f.editGuard.mockImplementation(() => { throw Object.assign(new Error("Protected target supplied as model reference"), { status: 422 }); });
    await expect(runGenerateJob(job())).rejects.toThrow("Protected target supplied as model reference");
    expect(f.precheck).not.toHaveBeenCalled(); expect(f.edit).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it("never dispatches an unavailable source, and does not fall back after an edit-provider error", async () => {
    row.jobData.studioEdit = { assetId: "source" };
    f.editSource.mockRejectedValue(new Error("Source SHA mismatch"));
    await expect(runGenerateJob(job())).rejects.toThrow("Source SHA mismatch");
    expect(f.precheck).not.toHaveBeenCalled(); expect(f.edit).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
    f.editSource.mockResolvedValue({ imageUrl: "data:image/png;base64,YQ==" }); f.edit.mockRejectedValue(new Error("upstream timeout"));
    await expect(runGenerateJob(job())).rejects.toThrow();
    expect(f.edit).toHaveBeenCalledOnce(); expect(f.generate).not.toHaveBeenCalled(); expect(f.stage).not.toHaveBeenCalled();
  });
  it.each([true, false])("fences after source validation and again directly before AI, targets=%s", async withTargets => {
    if (!withTargets) delete row.jobData.targets;
    await runGenerateJob(job());
    expect(events).toEqual(["sources", "rules", "references", "ready", "precheck", "ready", "provider", "stage", "finish:SUCCEEDED", "archive"]);
    expect(f.ready).toHaveBeenCalledTimes(2);
    expect(f.ready).toHaveBeenCalledWith(row, expect.any(AbortSignal));
    expect(f.generate).toHaveBeenCalledWith(expect.objectContaining({ providerRetryPolicy: "never" }), expect.objectContaining({ requireRealImageProvider: true }));
  });
  it("a context change during source loading prevents even text precheck", async () => {
    f.ready.mockImplementation(async () => { events.push("ready"); throw conflict(); });
    await expect(runGenerateJob(job())).rejects.toMatchObject({ status: 409 });
    expect(events).toEqual(["sources", "rules", "references", "ready", "finish:FAILED"]);
    expect(f.precheck).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled(); expect(f.stage).not.toHaveBeenCalled();
  });
  it("a context change while text precheck awaits stops the paid image call with the original 409", async () => {
    let changed = false;
    f.precheck.mockImplementation(async () => { events.push("precheck"); changed = true; return { blocking: false }; });
    f.ready.mockImplementation(async () => { events.push("ready"); if (changed) throw conflict(); });
    await expect(runGenerateJob(job())).rejects.toMatchObject({ status: 409, message: "Brand rules changed before dispatch" });
    expect(events).toEqual(["sources", "rules", "references", "ready", "precheck", "ready", "finish:FAILED"]);
    expect(f.generate).not.toHaveBeenCalled(); expect(f.stage).not.toHaveBeenCalled();
  });
  it("does not run readiness or paid work before a failing source preflight", async () => {
    f.exact.mockRejectedValue(new Error("source SHA changed"));
    await expect(runGenerateJob(job())).rejects.toThrow("source SHA changed");
    expect(f.ready).not.toHaveBeenCalled(); expect(f.precheck).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it("preserves legacy precheck order and never invokes the product fence", async () => {
    const legacyJob = job(); f.request.mockResolvedValue(null);
    f.generate.mockRejectedValue(new Error("stop legacy fixture before persistence"));
    await expect(runGenerateJob(legacyJob)).rejects.toThrow();
    expect(events).toEqual(["rules", "precheck"]);
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.ready).not.toHaveBeenCalled(); expect(f.refs).not.toHaveBeenCalled(); expect(f.exact).not.toHaveBeenCalled();
    expect(f.generate.mock.calls[0][0]).not.toHaveProperty("providerRetryPolicy");
  });
});
