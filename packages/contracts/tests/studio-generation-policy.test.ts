import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ prepare: vi.fn(), rules: vi.fn(), materials: vi.fn(), gate: vi.fn(), state: vi.fn(), doc: vi.fn(), assets: vi.fn(), proh: vi.fn(), edit: vi.fn(), inspectEdit: vi.fn() }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/settings", () => ({ getEffectiveAiSettings: vi.fn(), getEffectiveStorage: vi.fn() }));
vi.mock("../../../apps/web/src/lib/generation-prepare", () => ({ prepareGeneration: f.prepare }));
vi.mock("../../../apps/web/src/lib/rules", () => ({ getConfirmedRules: f.rules }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("../../../apps/web/src/lib/studio-project-materials", () => ({ listStudioProjectMaterials: f.materials }));
vi.mock("../../../apps/web/src/lib/studio-generation-edit", () => ({ resolveStudioEditSource: f.edit, inspectStudioEditSource: f.inspectEdit, assertStudioEditNotModelReference: vi.fn() }));
import { prepareStudioGeneration, studioGenerationContextHash } from "../../../apps/web/src/lib/studio-generation-policy";
const sha = "a".repeat(64), url = "/api/workspaces/w/assets/a/raw";
const input = { projectId: "p", mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", prompt: "tree", sizeSelection: { ratioKey: "1:1" as const, resolutionTier: "1K" as const }, workflowRevision: 1, documentRevision: 2 };
const reference = { shapeId: "shape:image", assetSha256: sha, purpose: "ADAPTIVE", participates: true };
const canvas = "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store: { "shape:image": { id: "shape:image", typeName: "shape", type: "c-image", props: { url, w: 20, h: 10 } } } } } })).toString("base64");
let state: any, db: any;
beforeEach(() => {
  vi.resetAllMocks(); state = { workspaceId: "w", workflowRevision: 1, workflowMode: "generate", workflowTarget: null, workflowReferences: [reference] };
  f.state.mockImplementation(async () => state); f.doc.mockResolvedValue({ workspaceId: "w", revision: 2, canvas }); f.materials.mockResolvedValue([{ assetId: "a", sha256: sha, mimeType: "image/png", url }]);
  f.rules.mockResolvedValue([]); f.proh.mockResolvedValue([]); f.assets.mockResolvedValue([{ id: "a", url: "http://private/w/a", storageKey: "w/a" }]);
  f.prepare.mockImplementation(async (_ws, value) => ({ generationData: {}, jobData: { versionCount: 1, assetUsages: value.assetUsages } }));
  f.edit.mockRejectedValue(Object.assign(new Error("Edit source unavailable"), { status: 422 }));
  db = { workbenchProjectState: { findUnique: f.state }, editorDocument: { findUnique: f.doc }, asset: { findMany: f.assets }, prohibitionRule: { findMany: f.proh } };
});
describe("saved workflow selection to company generation", () => {
  it("freezes an authorized edit target in the existing quota preparation and revalidates its source independently of later canvas state", async () => {
    state.workflowMode = "modify"; state.workflowTarget = { shapeId: "shape:image", assetSha256: sha }; state.workflowReferences = [];
    const snapshot = { assetId: "a", sha256: sha, width: 20, height: 10, shapeId: "shape:image", recipeHash: "b".repeat(64) };
    f.edit.mockResolvedValue({ snapshot, postprocess: null }); f.assets.mockResolvedValue([]);
    const accepted = await prepareStudioGeneration(db, "w", "u", input);
    expect(accepted.jobData.studioEdit).toEqual(snapshot); expect(accepted.jobData.assetUsages).toEqual([]);
    expect(f.edit).toHaveBeenCalledWith(db, "w", "p", state.workflowTarget, canvas);
    expect(f.inspectEdit).toHaveBeenCalledWith(db, "w", "p", snapshot);
    f.doc.mockClear(); f.state.mockClear();
    expect(await studioGenerationContextHash(db, "w", "p", accepted.jobData)).toBe(accepted.contextHash);
    expect(f.doc).not.toHaveBeenCalled(); expect(f.state).not.toHaveBeenCalled();
    f.inspectEdit.mockRejectedValue(Object.assign(new Error("Source changed"), { status: 422 }));
    await expect(studioGenerationContextHash(db, "w", "p", accepted.jobData)).rejects.toMatchObject({ status: 422 });
  });
  it("inherits locked originals at the target's saved placement, permits same-ratio resolution changes and refuses a different ratio", async () => {
    state.workflowMode = "modify"; state.workflowTarget = { shapeId: "shape:image", assetSha256: sha }; state.workflowReferences = [];
    const layout = { target: { width: 1024, height: 1024 }, layers: [{ assetId: "locked", sha256: "b".repeat(64) }], assetUsages: [{ assetId: "locked", mode: "EXACT", order: 0, exactTransform: { xRatio: .3, yRatio: .4, widthRatio: .2 } }] };
    f.edit.mockResolvedValue({ snapshot: { assetId: "a" }, postprocess: { exactLayout: layout } }); f.assets.mockResolvedValue([{ id: "locked" }]);
    const result = await prepareStudioGeneration(db, "w", "u", { ...input, sizeSelection: { ratioKey: "1:1", resolutionTier: "2K" } });
    expect(result.jobData.studioExactLayout).toMatchObject({ target: { width: 2048, height: 2048 }, layers: layout.layers });
    expect(result.jobData.studioExpectedAssetSha256).toEqual({ locked: "b".repeat(64) });
    f.prepare.mockClear();
    await expect(prepareStudioGeneration(db, "w", "u", { ...input, sizeSelection: { ratioKey: "3:2", resolutionTier: "1K" } })).rejects.toMatchObject({ status: 422 });
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("does not add new locked materials to a whole-image edit or accept an unrelated output frame", async () => {
    state.workflowMode = "modify"; state.workflowTarget = { shapeId: "shape:image", assetSha256: sha }; state.workflowReferences = [{ ...reference, purpose: "EXACT" }];
    f.materials.mockResolvedValue([{ assetId: "a", sha256: sha, mimeType: "image/png", url, width: 20, height: 10 }]);
    f.edit.mockResolvedValue({ snapshot: { assetId: "a" }, postprocess: null });
    await expect(prepareStudioGeneration(db, "w", "u", input)).rejects.toMatchObject({ status: 422 });
    await expect(prepareStudioGeneration(db, "w", "u", { ...input, outputFrameId: "shape:frame" })).rejects.toMatchObject({ status: 422 });
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("resolves actual shape URL through project-authorized materials and preserves explicit ADAPTIVE/REFERENCE order", async () => {
    const result = await prepareStudioGeneration(db, "w", "u", input);
    expect(f.gate).toHaveBeenCalledWith(db, "w", "p", "u");
    expect(result.jobData.assetUsages).toEqual([expect.objectContaining({ assetId: "a", mode: "ADAPTIVE", order: 0 })]);
    expect(result.jobData.studioExpectedAssetSha256).toEqual({ a: sha });
    state.workflowReferences = [{ ...reference, purpose: "REFERENCE" }];
    expect((await prepareStudioGeneration(db, "w", "u", input)).jobData.assetUsages).toEqual([expect.objectContaining({ mode: "REFERENCE" })]);
    expect(f.prepare).toHaveBeenCalledWith("w", expect.objectContaining({ chatDisplayText: "tree", versionCount: 1, textMode: "direct" }), { client: db, persistHardBlock: false });
  });
  it("rejects incomplete EXACT, unavailable edit sources, stale revisions and changed SHA instead of dropping selection", async () => {
    state.workflowReferences = [{ ...reference, purpose: "EXACT" }]; await expect(prepareStudioGeneration(db, "w", "u", input)).rejects.toMatchObject({ status: 422 });
    state.workflowReferences = [reference]; state.workflowMode = "modify"; state.workflowTarget = { shapeId: reference.shapeId, assetSha256: sha };
    await expect(prepareStudioGeneration(db, "w", "u", input)).rejects.toMatchObject({ status: 422 });
    state.workflowMode = "generate"; state.workflowTarget = null;
    await expect(prepareStudioGeneration(db, "w", "u", { ...input, documentRevision: 1 })).rejects.toMatchObject({ status: 409 });
    f.materials.mockResolvedValue([{ assetId: "a", sha256: "b".repeat(64), mimeType: "image/png", url }]); await expect(prepareStudioGeneration(db, "w", "u", input)).rejects.toMatchObject({ status: 422 });
    f.materials.mockResolvedValue([]); await expect(prepareStudioGeneration(db, "w", "u", input)).rejects.toMatchObject({ status: 422 }); expect(f.prepare).not.toHaveBeenCalled();
  });
  it("worker snapshot hash ignores later canvas/workflow edits but changes when its authoritative source changes", async () => {
    const job = { assetUsages: [{ assetId: "a", mode: "ADAPTIVE" }], versionCount: 1, studioExpectedAssetSha256: { a: sha } };
    const accepted = await studioGenerationContextHash(db, "w", "p", job);
    state.workflowRevision = 10; f.doc.mockResolvedValue({ revision: 30 });
    expect(await studioGenerationContextHash(db, "w", "p", { ...job, generationId: "g" })).toBe(accepted);
    expect(await studioGenerationContextHash(db, "w", "p", { ...job, studioExpectedAssetSha256: { a: "b".repeat(64) } })).not.toBe(accepted);
    expect(f.state).not.toHaveBeenCalled(); expect(f.doc).not.toHaveBeenCalled();
    f.assets.mockResolvedValue([{ id: "a", url: "http://new/w/a", storageKey: "w/new" }]); expect(await studioGenerationContextHash(db, "w", "p", job)).not.toBe(accepted);
    f.assets.mockResolvedValue([]); await expect(studioGenerationContextHash(db, "w", "p", job)).rejects.toMatchObject({ status: 422 });
  });
  it("derives EXACT from the saved frame and authenticated source size, never a default placement", async () => {
    state.workflowReferences = [{ ...reference, purpose: "EXACT" }];
    f.materials.mockResolvedValue([{ assetId: "a", sha256: sha, mimeType: "image/png", url, width: 20, height: 10 }]);
    const store = {
      "page:one": { id: "page:one", typeName: "page", name: "Page" },
      "shape:frame": { id: "shape:frame", typeName: "shape", type: "frame", parentId: "page:one", index: "a1", x: 200, y: 300, rotation: 0, props: { w: 100, h: 100 } },
      "shape:image": { id: "shape:image", typeName: "shape", type: "c-image", parentId: "shape:frame", index: "a1", x: 10, y: 20, rotation: 0, props: { url, w: 20, h: 10 } },
    };
    const saved = "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store } } })).toString("base64");
    f.doc.mockResolvedValue({ workspaceId: "w", revision: 2, canvas: saved });
    const result = await prepareStudioGeneration(db, "w", "u", { ...input, outputFrameId: "shape:frame" });
    expect(result.jobData.assetUsages).toEqual([expect.objectContaining({ assetId: "a", mode: "EXACT", exactTransform: expect.objectContaining({ xRatio: .2, yRatio: .25, widthRatio: .2 }) })]);
    expect(result.jobData.studioExactLayout?.frame).toMatchObject({ shapeId: "shape:frame", width: 100, height: 100, pageId: "page:one" });
    expect(result.jobData.studioExactLayout?.layers[0]).toMatchObject({ sha256: sha, width: 20, height: 10 });
    f.prepare.mockClear();
    f.materials.mockResolvedValue([{ assetId: "a", sha256: sha, mimeType: "image/png", url, width: 20, height: null }]);
    await expect(prepareStudioGeneration(db, "w", "u", { ...input, outputFrameId: "shape:frame" })).rejects.toMatchObject({ status: 422 });
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rejects extraneous output selection and unnamed EXACT instances instead of silently selecting another shape", async () => {
    await expect(prepareStudioGeneration(db, "w", "u", { ...input, outputFrameId: "shape:frame" })).rejects.toMatchObject({ status: 422 });
    state.workflowReferences = [{ ...reference, shapeId: null, purpose: "EXACT" }];
    await expect(prepareStudioGeneration(db, "w", "u", { ...input, outputFrameId: "shape:frame" })).rejects.toMatchObject({ status: 422 });
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
