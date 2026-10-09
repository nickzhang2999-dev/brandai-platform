import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateGenerationInput } from "../src";
const f = vi.hoisted(() => ({ project: vi.fn(), assets: vi.fn(), versions: vi.fn(), workspace: vi.fn(), rules: vi.fn(), proh: vi.fn(), create: vi.fn(), assertAssets: vi.fn(), compile: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { project: { findUnique: f.project }, asset: { findMany: f.assets }, generationVersion: { findMany: f.versions }, brandWorkspace: { findUnique: f.workspace }, prohibitionRule: { findMany: f.proh }, generation: { create: f.create } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/rules", () => ({ getConfirmedRules: f.rules }));
vi.mock("../../../apps/web/src/lib/prohibitions", () => ({ assertExampleAssetsInWorkspace: f.assertAssets, serializeProhibition: (v: unknown) => v }));
vi.mock("../../../apps/web/src/lib/ai-constraints", () => ({ constraintsEnabled: () => true, compileAIConstraints: f.compile }));
import { prepareGeneration } from "../../../apps/web/src/lib/generation-prepare";
beforeEach(() => {
  vi.resetAllMocks(); f.project.mockResolvedValue({ id: "p", workspaceId: "w", name: "Project" }); f.workspace.mockResolvedValue({ name: "Brand", industry: "design" });
  f.assets.mockImplementation(async ({ where }) => where.id.in.map((id: string) => ({ id, url: "http://private-source/" + id })));
  f.versions.mockResolvedValue([{ id: "v", imageUrl: "https://version" }]); f.rules.mockResolvedValue([]); f.proh.mockResolvedValue([]); f.compile.mockReturnValue({ blockers: [] }); f.create.mockResolvedValue({ id: "blocked" });
});
describe("shared company generation preparation compatibility", () => {
  it("keeps legacy STRICT watermark semantics separate from modern EXACT transforms", async () => {
    const result = await prepareGeneration("w", CreateGenerationInput.parse({ projectId: "p", sceneType: "SOCIAL_POSTER", referenceAssets: [{ assetId: "legacy", mode: "STRICT" }], assetUsages: [{ assetId: "exact", mode: "EXACT", order: 0 }] }));
    expect(result.jobData.watermarkOverlays).toEqual([expect.objectContaining({ assetId: "legacy", anchor: "bottom-right", widthPx: 120, offsetX: 24 })]);
    expect(result.jobData.assetUsages).toEqual([expect.objectContaining({ assetId: "exact", mode: "EXACT" })]);
    expect(result.jobData.templateReferenceAssetIds).toBeUndefined(); expect(result.jobData.versionCount).toBe(2); expect(result.jobData.textMode).toBe("direct");
  });
  it("keeps chat display text literal, ASSET canonical proxy and project-scoped VERSION lookup", async () => {
    const result = await prepareGeneration("w", CreateGenerationInput.parse({ projectId: "p", sceneType: "SOCIAL_POSTER", chatDisplayText: "user text", sellingPoint: "actual prompt", imageInputs: [{ kind: "ASSET", id: "a" }, { kind: "VERSION", id: "v" }] }));
    expect(result.generationData.chatContext).toEqual({ displayText: "user text", imageInputs: [{ kind: "ASSET", id: "a", url: "/api/workspaces/w/assets/a/raw" }, { kind: "VERSION", id: "v", url: "https://version" }] });
    expect(f.versions).toHaveBeenCalledWith({ where: { id: { in: ["v"] }, generation: { workspaceId: "w", projectId: "p" } }, select: { id: true, imageUrl: true } });
    expect(result.generationData.sellingPoint).toBe("actual prompt"); expect(result.generationData.scene).toBe("");
  });
  it("still records legacy hard-block failures with chat context, while product rejects before quota", async () => {
    f.compile.mockReturnValue({ blockers: [{ source: "rule", reason: "HIGH blocker" }] });
    const input = CreateGenerationInput.parse({ projectId: "p", sceneType: "SOCIAL_POSTER", chatDisplayText: "text" });
    await expect(prepareGeneration("w", input)).rejects.toMatchObject({ status: 422, details: { generationId: "blocked" } });
    expect(f.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "FAILED", chatContext: { displayText: "text", imageInputs: [] } }) });
    f.create.mockClear(); await expect(prepareGeneration("w", input, { persistHardBlock: false })).rejects.toMatchObject({ status: 422 }); expect(f.create).not.toHaveBeenCalled();
  });
  it("fails foreign projects and missing chat sources without producing pending generation data", async () => {
    f.project.mockResolvedValue({ workspaceId: "other" }); await expect(prepareGeneration("w", { projectId: "p", sceneType: "SOCIAL_POSTER" })).rejects.toMatchObject({ status: 404 });
    f.project.mockResolvedValue({ workspaceId: "w" }); f.versions.mockResolvedValue([]);
    await expect(prepareGeneration("w", { projectId: "p", sceneType: "SOCIAL_POSTER", imageInputs: [{ kind: "VERSION", id: "foreign" }] })).rejects.toMatchObject({ status: 400 }); expect(f.create).not.toHaveBeenCalled();
  });
});
