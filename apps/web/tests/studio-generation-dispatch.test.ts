import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ request: vi.fn(), claim: vi.fn(), ready: vi.fn(), finish: vi.fn(), stage: vi.fn(), archive: vi.fn(), exact: vi.fn(), refs: vi.fn(), rules: vi.fn(), precheck: vi.fn(), generate: vi.fn(), generation: vi.fn(), update: vi.fn(), updateMany: vi.fn(), tx: vi.fn(), createVersion: vi.fn(), upload: vi.fn(), assets: vi.fn(), roots: vi.fn(), usage: vi.fn(), settings: vi.fn(), editSource: vi.fn(), edit: vi.fn(), editGuard: vi.fn(), brandPolicy: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ Prisma: {}, prisma: {
  studioGenerationRequest: { findUnique: f.request }, generation: { findUnique: f.generation, update: f.update, updateMany: f.updateMany }, $transaction: f.tx,
  brandWorkspace: { findUnique: async () => ({ ownerId: "u" }) }, prohibitionRule: { findMany: async () => [] },
  asset: { findMany: f.assets }, generationVersion: { findMany: f.roots, create: f.createVersion },
} }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/studio-generation-lifecycle", () => ({ claimStudioGeneration: f.claim, assertStudioGenerationReady: f.ready, finishStudioGeneration: f.finish, stageStudioGenerationOutput: f.stage }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ ensureStudioGenerationArtifacts: f.archive }));
vi.mock("@/lib/studio-generation-exact", () => ({ studioExactIntent: () => ({ layout: null, modelExpected: {} }), preflightStudioExactSources: f.exact, assertStudioExactNotModelInput: vi.fn() }));
vi.mock("@/lib/studio-generation-references", () => ({ inlineStudioGenerationReferences: f.refs, studioProviderParams: () => ({}) }));
vi.mock("@/lib/ai", () => ({ ai: { generate: f.generate, studioEdit: f.edit } }));
vi.mock("@/lib/studio-generation-edit", () => ({ loadStudioEditSource: f.editSource, assertStudioEditNotModelReference: f.editGuard }));
vi.mock("@/lib/studio-generation-base", () => ({ requireStudioBaseEncryption: vi.fn() }));
vi.mock("@/lib/s3", () => ({ uploadDataUrlImage: f.upload }));
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
import { runGenerateJob } from "../src/lib/workers/generate.worker";

let row: any, events: string[];
const conflict = () => Object.assign(new Error("Brand rules changed before dispatch"), { status: 409 });
const job = () => ({ data: { ...row.jobData }, updateProgress: vi.fn().mockResolvedValue(undefined) } as any);
beforeEach(() => {
  vi.resetAllMocks(); events = [];
  row = { id: "request", workspaceId: "w", projectId: "p", userId: "u", generationId: "g", status: "RUNNING", providerStartedAt: new Date(), expiresAt: new Date(Date.now() + 60000),
    jobData: { generationId: "g", generationAttemptToken: "synthetic-attempt", workspaceId: "w", versionCount: 1, targets: [{ key: "square", label: "Square", width: 1024, height: 1024 }] } };
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
  f.updateMany.mockResolvedValue({ count: 1 });
  f.tx.mockImplementation(work => work({ generation: { updateMany: f.updateMany }, generationVersion: { create: f.createVersion } }));
  f.createVersion.mockImplementation(async () => ({ id: `version-${f.createVersion.mock.calls.length}` }));
  f.upload.mockImplementation(async value => value);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("real generation worker pre-provider ordering (isolated dependencies)", () => {
  it.each([true, false])("adapts custom dialog model pixels while preserving archival pixels, edit=%s", async editing => {
    row.jobData.targets = [{ key: "conversation", label: "Dialog", width: 1024, height: 576 }];
    row.jobData.studioConversationSize = { requestedSize: { width: 1024, height: 576 }, sizeSource: "dialog-pixels", method: "deterministic-contain" };
    if (editing) {
      row.jobData.studioEdit = { assetId: "source", sha256: "a".repeat(64), shapeId: "shape:source", width: 1280, height: 720, recipeHash: "b".repeat(64) };
      f.editSource.mockResolvedValue({ imageUrl: "data:image/png;base64,YQ==" });
      f.edit.mockResolvedValue({ versions: [{ imageUrl: "data:image/png;base64,Yg==", width: 1280, height: 720, params: {} }] });
    }
    await runGenerateJob(job());
    const transport = editing ? f.edit.mock.calls[0][0].generation : f.generate.mock.calls[0][0];
    expect(transport.targets).toEqual([{ key: "conversation", label: "Dialog", width: 1280, height: 720 }]);
    expect(transport.providerRetryPolicy).toBe("never");
    expect(editing ? f.edit : f.generate).toHaveBeenCalledOnce();
    expect(editing ? f.generate : f.edit).not.toHaveBeenCalled();
    expect(row.jobData.targets[0]).toMatchObject({ width: 1024, height: 576 });
    expect(f.stage.mock.calls[0][1].params.studioPostprocess.conversationSize.requestedSize).toEqual({ width: 1024, height: 576 });
  });
  it("image tools alone read the displayed source, preserve one paid request and omit added overlays", async () => {
    row.jobData.studioEdit = { assetId:"source",sha256:"a".repeat(64),shapeId:"shape:source",width:48,height:32,recipeHash:"b".repeat(64) };
    row.jobData.studioImageTool = { operation:"remove-background" };
    f.editSource.mockResolvedValue({imageUrl:"data:image/png;base64,YQ=="});
    f.edit.mockResolvedValue({versions:[{imageUrl:"data:image/png;base64,Yg==",width:1024,height:1024,params:{}}]});
    await runGenerateJob(job());
    expect(f.editSource).toHaveBeenCalledWith("w","p",row.jobData.studioEdit,expect.any(AbortSignal),true);
    expect(f.edit).toHaveBeenCalledOnce();expect(f.generate).not.toHaveBeenCalled();
    expect(f.edit.mock.calls[0][0]).toMatchObject({imageTool:{operation:"remove-background"},generation:{providerRetryPolicy:"never",brandRules:[],aiConstraints:{referenceImages:[]}}});
    expect(f.stage.mock.calls[0][1].params.studioPostprocess).toMatchObject({imageTool:"remove-background",watermarkOverlays:[],automaticBrandLogoAssetId:null,brandRules:[]});
  });

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
    expect(f.generate.mock.calls[0][0]).toHaveProperty("providerRetryPolicy", "never");
  });
});

describe("legacy generation cancellation and multi-size budget (unit provider fixtures)", () => {
  const result = () => ({ versions: [{ imageUrl: "data:image/png;base64,YQ==", width: 1024, height: 1024, params: {} }] });
  function legacyJob(count = 2) {
    vi.useFakeTimers(); vi.stubEnv("AUTO_COMPLIANCE_V1", "0");
    f.request.mockResolvedValue(null);
    const value = job();
    value.data.targets = Array.from({ length: count }, (_, index) => ({ key: `size-${index}`, label: "Size", width: 1024, height: 1024 }));
    return value;
  }
  it("finishes two sequential sizes after five minutes without an early batch failure", async () => {
    const value = legacyJob();
    f.generate.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(result()), 165_000)));
    const pending = runGenerateJob(value); await vi.advanceTimersByTimeAsync(300_001);
    expect(f.updateMany.mock.calls.some(([args]) => args.data.status === "FAILED")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).versionIds).toHaveLength(2);
    expect(f.createVersion).toHaveBeenCalledTimes(2);
    expect(f.updateMany.mock.calls.at(-1)?.[0].data.status).toBe("SUCCEEDED");
  });
  it("aborts one overdue size, advances once to the next, and discards the late first result", async () => {
    const value = legacyJob(); let late!: (value: unknown) => void;
    f.generate.mockImplementationOnce(() => new Promise(resolve => { late = resolve; })).mockResolvedValue(result());
    const pending = runGenerateJob(value); await vi.advanceTimersByTimeAsync(180_001);
    expect((await pending).versionIds).toHaveLength(1);
    expect(f.generate).toHaveBeenCalledTimes(2); expect(f.generate.mock.calls[0][1].signal.aborted).toBe(true);
    late(result()); await vi.advanceTimersByTimeAsync(0);
    expect(f.createVersion).toHaveBeenCalledOnce();
    expect(f.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({ status: "SUCCEEDED", error: expect.stringContaining("超时") });
  });
  it("aborts a single-size hung provider and never persists its late success", async () => {
    const value = legacyJob(); delete value.data.targets; let late!: (value: unknown) => void;
    f.generate.mockImplementation(() => new Promise(resolve => { late = resolve; }));
    const outcome = runGenerateJob(value).then(() => "unexpected", error => String(error));
    await vi.advanceTimersByTimeAsync(300_001);
    expect(await outcome).toContain("timed out"); expect(f.generate.mock.calls[0][1].signal.aborted).toBe(true);
    late(result()); await vi.advanceTimersByTimeAsync(0);
    expect(f.createVersion).not.toHaveBeenCalled(); expect(f.updateMany.mock.calls.at(-1)?.[0].data.status).toBe("FAILED");
  });
  it("stops a delayed object-store result at the write fence after timeout", async () => {
    const value = legacyJob(1); let late!: (value: string) => void;
    f.generate.mockResolvedValue(result()); f.upload.mockImplementation(() => new Promise(resolve => { late = resolve; }));
    const outcome = runGenerateJob(value).then(() => "unexpected", error => String(error));
    await vi.advanceTimersByTimeAsync(180_001);
    expect(await outcome).toContain("超时");
    expect(f.upload.mock.calls[0][2].aborted).toBe(true);
    late("https://synthetic.invalid/stored.png"); await vi.advanceTimersByTimeAsync(0);
    expect(f.createVersion).not.toHaveBeenCalled();
  });
  it("does not issue a paid call when another worker already claimed the generation", async () => {
    const value = legacyJob(); f.updateMany.mockResolvedValue({ count: 0 });
    expect(await runGenerateJob(value)).toEqual({ generationId: "g", versionIds: [] });
    expect(f.generate).not.toHaveBeenCalled(); expect(f.createVersion).not.toHaveBeenCalled();
  });
  it("times out a hung legacy database claim, and refuses a late claim before paid work", async () => {
    const value = legacyJob(1); let late!: (value: unknown) => void;
    f.updateMany.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    const outcome = runGenerateJob(value).catch(error => String(error));
    await vi.advanceTimersByTimeAsync(240_001);
    expect(await outcome).toContain("timed out"); expect(f.generate).not.toHaveBeenCalled();
    late({ count: 1 }); await vi.advanceTimersByTimeAsync(0);
    expect(f.generate).not.toHaveBeenCalled(); expect(f.createVersion).not.toHaveBeenCalled();
    expect(f.updateMany.mock.calls.at(-1)?.[0].data.status).toBe("FAILED");
  });
  it("releases the worker slot even when failure persistence hangs", async () => {
    const value = legacyJob(1);
    f.updateMany.mockImplementationOnce(async () => ({ count: 1 })).mockImplementation(() => new Promise(() => {}));
    f.generate.mockRejectedValue(new Error("synthetic provider failure"));
    const outcome = runGenerateJob(value).catch(error => String(error));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await outcome).toContain("synthetic provider failure"); expect(f.generate).toHaveBeenCalledOnce();
  });
  it("cannot claim a newer retry using an old or absent submission token", async () => {
    const value = legacyJob(1);
    f.updateMany.mockImplementation(async ({ where }) => ({ count: where.attemptToken === "current-attempt" ? 1 : 0 }));
    expect(await runGenerateJob(value)).toEqual({ generationId: "g", versionIds: [] });
    expect(f.updateMany.mock.calls[0][0].where.attemptToken).toBe("synthetic-attempt");
    delete value.data.generationAttemptToken;
    await expect(runGenerateJob(value)).rejects.toThrow("本轮凭据");
    expect(f.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({ where: { id: "g", workspaceId: "w", attemptToken: null, status: "PENDING", studioRequest: { is: null } }, data: { status: "FAILED" } });
    expect(f.generate).not.toHaveBeenCalled(); expect(f.createVersion).not.toHaveBeenCalled();
  });
  it("gives an old tokenless pending generation a failure exit without waiting for the sweep", async () => {
    const value = legacyJob(1); delete value.data.generationAttemptToken;
    const stored = { id: "g", workspaceId: "w", status: "PENDING", attemptToken: null };
    f.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.attemptToken !== stored.attemptToken || where.status !== stored.status) return { count: 0 };
      Object.assign(stored, data); return { count: 1 };
    });
    await expect(runGenerateJob(value)).rejects.toThrow("本轮凭据");
    expect(stored.status).toBe("FAILED"); expect(f.generate).not.toHaveBeenCalled();
  });
  it("moves to the next size after three minutes even if the first storage adapter ignores abort", async () => {
    const value = legacyJob(2); let late!: (value: string) => void;
    f.generate.mockResolvedValue(result());
    f.upload.mockImplementationOnce(() => new Promise(resolve => { late = resolve; })).mockResolvedValue("https://synthetic.invalid/second.png");
    const pending = runGenerateJob(value);
    await vi.advanceTimersByTimeAsync(180_001);
    expect((await pending).versionIds).toHaveLength(1); expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.upload.mock.calls[0][2].aborted).toBe(true); expect(f.createVersion).toHaveBeenCalledOnce();
    late("https://synthetic.invalid/late.png"); await vi.advanceTimersByTimeAsync(0);
    expect(f.createVersion).toHaveBeenCalledOnce();
  });
});
