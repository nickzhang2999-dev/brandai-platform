import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const f = vi.hoisted(() => ({ db: {} as any, auth: vi.fn(), gate: vi.fn(), trusted: vi.fn(), resolve: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: f.db }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/studio-materials", () => ({ requireStudioMaterialProject: f.auth }));
vi.mock("../src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("../src/lib/studio-brand-materials", () => ({ requireTrustedStudioBrandProjectMaterial: f.trusted }));
vi.mock("../src/lib/studio-generation-edit", () => ({ resolveStudioEditSource: f.resolve }));
import { readStudioProjectContext, saveStudioProjectContext, freezeStudioProjectContext, assertStudioProjectContextSources } from "../src/lib/studio-project-context";
import { ApiException } from "../src/lib/api";
const facts = { goal: "夏季海报", audience: "大学生", approvedCopy: "清爽每一天", visualRequirements: "清晰排版" };
const sha = "a".repeat(64), input = () => ({ mutationId: randomUUID(), expectedRevision: 0, facts, materials: [{ assetId: "a", assetSha256: sha, role: "PRODUCT" }], master: null });
let state: any, mutations: any[];
beforeEach(() => {
  vi.resetAllMocks(); state = { workspaceId: "w", brief: "不要改brief", notes: "不要改notes", revision: 7, workflowRevision: 9, contextRevision: 0, contextJson: null }; mutations = [];
  f.trusted.mockImplementation(async (_db, ws, project, assetId, expected) => {
    if (ws !== "w" || project !== "p" || assetId !== "a" || expected !== sha) throw new ApiException(404, "Source unavailable");
    return { assetId: "a", assetSha256: sha, fileName: "产品图", width: 96, height: 64, generationVersionId: "version-a" };
  });
  f.resolve.mockResolvedValue({ snapshot: { assetId: "a", width: 96, height: 64 } });
  Object.assign(f.db, { $transaction: async (fn: any) => fn(f.db),
    workbenchProjectState: { findUnique: vi.fn(async () => state), upsert: vi.fn(async ({ create, update }: any) => { state = state ? { ...state, ...update } : create; return state; }) },
    editorDocument: { findUnique: vi.fn(async () => ({ workspaceId: "w", revision: 3, canvas: "verified-saved-canvas" })) },
    studioProjectContextMutation: { findUnique: vi.fn(async ({ where }: any) => mutations.find(row => Object.entries(where.workspaceId_projectId_userId_mutationId).every(([key, value]) => row[key] === value)) ?? null),
      create: vi.fn(async ({ data }: any) => { mutations.push(data); return data; }) } });
});
describe("confirmed project context service (in-memory DB dependencies, no real DB/provider)", () => {
  it("saves an independent revision and receipt without overwriting brief, notes, workflow or permissions", async () => {
    const request = input(); const result = await saveStudioProjectContext("w", "u", "p", request);
    expect(f.auth).toHaveBeenCalledWith("w", "u", "p", true); expect(f.gate).toHaveBeenCalledWith(f.db, "w", "p", "u");
    expect(result).toMatchObject({ revision: 1, facts, issues: [], materials: [{ role: "PRODUCT", versionId: "version-a", width: 96, height: 64 }] });
    expect(state).toMatchObject({ brief: "不要改brief", notes: "不要改notes", revision: 7, workflowRevision: 9 });
    expect(f.db.workbenchProjectState.upsert.mock.calls[0][0].update).not.toHaveProperty("workflowReferences");
    await expect(saveStudioProjectContext("w", "u", "p", request)).resolves.toEqual(result);
    expect(mutations).toHaveLength(1); expect(f.db.workbenchProjectState.upsert).toHaveBeenCalledTimes(1);
  });
  it("requires current revision, denies changed replays and never reapplies an older mutation", async () => {
    const request = input(); await saveStudioProjectContext("w", "u", "p", request);
    await expect(saveStudioProjectContext("w", "u", "p", { ...request, facts: { ...facts, goal: "别的内容" } })).rejects.toMatchObject({ status: 409 });
    await expect(saveStudioProjectContext("w", "u", "p", input())).rejects.toMatchObject({ status: 409 });
    await saveStudioProjectContext("w", "u", "p", { ...input(), expectedRevision: 1 });
    await expect(saveStudioProjectContext("w", "u", "p", request)).rejects.toMatchObject({ status: 409 }); expect(state.contextRevision).toBe(2);
  });
  it("allows viewers to read but uses the write/archival guard before every mutation", async () => {
    await readStudioProjectContext("w", "viewer", "p"); expect(f.auth).toHaveBeenCalledWith("w", "viewer", "p");
    f.gate.mockRejectedValue(new ApiException(403, "Editor required"));
    await expect(saveStudioProjectContext("w", "viewer", "p", input())).rejects.toMatchObject({ status: 403 });
    f.gate.mockRejectedValue(new ApiException(409, "Archived"));
    await expect(saveStudioProjectContext("w", "u", "p", input())).rejects.toMatchObject({ status: 409 }); expect(mutations).toHaveLength(0);
  });
  it("rejects foreign/unverified new assets and keeps a removed old entry visible with an issue", async () => {
    await expect(saveStudioProjectContext("w", "u", "p", { ...input(), materials: [{ assetId: "foreign", assetSha256: sha, role: "STYLE" }] })).rejects.toMatchObject({ status: 404 });
    await saveStudioProjectContext("w", "u", "p", input());
    f.trusted.mockRejectedValue(new ApiException(404, "Removed"));
    const result = await readStudioProjectContext("w", "u", "p");
    expect(result.materials).toHaveLength(1); expect(result.issues).toMatchObject([{ scope: "material", assetId: "a", code: "SOURCE_UNAVAILABLE" }]);
    const edited = await saveStudioProjectContext("w", "u", "p", { ...input(), expectedRevision: 1, facts: { ...facts, goal: "只改文字资料" } });
    expect(edited.materials).toHaveLength(1); expect(edited.issues).toHaveLength(1);
    await expect(freezeStudioProjectContext(f.db, "w", "p", 2)).rejects.toMatchObject({ status: 409 });
  });
  it("binds a selected master to its actual saved canvas and authoritative version/dimensions", async () => {
    const request = { ...input(), master: { assetId: "a", assetSha256: sha, shapeId: "shape:a", versionId: "version-a" }, documentRevision: 3 };
    const result = await saveStudioProjectContext("w", "u", "p", request);
    expect(f.resolve).toHaveBeenCalledWith(f.db, "w", "p", { shapeId: "shape:a", assetSha256: sha }, "verified-saved-canvas", true);
    expect(result.master).toMatchObject({ assetId: "a", versionId: "version-a", shapeId: "shape:a", width: 96, height: 64 });
    await expect(saveStudioProjectContext("w", "u", "p", { ...request, master: { ...request.master, shapeId: "shape:another" }, mutationId: randomUUID(), expectedRevision: 1, documentRevision: 2 })).rejects.toMatchObject({ status: 409 });
    f.resolve.mockResolvedValue({ snapshot: { assetId: "forged", width: 96, height: 64 } });
    await expect(saveStudioProjectContext("w", "u", "p", { ...request, master: { ...request.master, shapeId: "shape:another" }, mutationId: randomUUID(), expectedRevision: 1 })).rejects.toMatchObject({ status: 422 });
    f.resolve.mockClear(); f.db.editorDocument.findUnique.mockResolvedValue(null);
    await expect(saveStudioProjectContext("w", "u", "p", { ...request, mutationId: randomUUID(), expectedRevision: 1, facts: { ...facts, goal: "修改资料无需重新选择主稿" } })).resolves.toMatchObject({ revision: 2, issues: [] });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("freezes facts for accepted work; later edits do not rewrite it, revoked sources still stop consumption", async () => {
    await saveStudioProjectContext("w", "u", "p", input());
    const frozen = await freezeStudioProjectContext(f.db, "w", "p", 1);
    await saveStudioProjectContext("w", "u", "p", { ...input(), expectedRevision: 1, facts: { ...facts, goal: "后来的内容" } });
    await expect(assertStudioProjectContextSources(f.db, "w", "p", frozen)).resolves.toBeUndefined(); expect(frozen.facts.goal).toBe(facts.goal);
    await expect(freezeStudioProjectContext(f.db, "w", "p", 1)).rejects.toMatchObject({ status: 409 });
    f.trusted.mockResolvedValue({ fileName: "产品图", width: 96, height: 64, generationVersionId: "replaced-version" });
    await expect(assertStudioProjectContextSources(f.db, "w", "p", frozen)).rejects.toMatchObject({ status: 409 });
    await expect(assertStudioProjectContextSources(f.db, "w", "foreign", frozen)).rejects.toMatchObject({ status: 404 });
  });
});
