import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ gate: vi.fn(), project: vi.fn(), document: vi.fn(), materials: vi.fn(), material: vi.fn(), state: vi.fn(), save: vi.fn(), lock: vi.fn(), transaction: vi.fn() }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../db/src/index", () => ({
  Prisma: { DbNull: "database-null", TransactionIsolationLevel: { ReadCommitted: "ReadCommitted", RepeatableRead: "RepeatableRead" } },
  prisma: { project: { findFirst: f.project }, studioMaterialUpload: { findFirst: f.material }, $transaction: f.transaction },
}));
import { readStudioWorkflow, readStudioWorkflowAssets, saveStudioWorkflow, studioWorkflowImage } from "../../../apps/web/src/lib/studio-workflow";

const sha = "a".repeat(64), url = "/api/workspaces/w/assets/a/raw";
const ref = { shapeId: "shape:image", assetSha256: sha, purpose: "EXACT", participates: true };
const input = { projectId: "p", revision: 0, mode: "generate", target: null, references: [ref] };
const savedAt = new Date("2026-10-09T00:00:00Z");
const emptyState = { workspaceId: "w", workflowRevision: 0, workflowMode: "generate", workflowTarget: null, workflowReferences: [], workflowUpdatedAt: null };
const canvas = "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store: {
  "shape:image": { id: "shape:image", typeName: "shape", type: "c-image", props: { url, w: 20, h: 30 } },
} } } })).toString("base64");
beforeEach(() => {
  vi.resetAllMocks();
  f.gate.mockResolvedValue({ role: "EDITOR" }); f.project.mockResolvedValue({ id: "p" });
  f.lock.mockResolvedValue([{ archivedAt: null, description: "existing brief" }]);
  f.document.mockResolvedValue({ workspaceId: "w", format: "novart-native-v1", canvas });
  f.state.mockResolvedValue(null);
  f.materials.mockResolvedValue([{ sha256: sha, mimeType: "image/png", asset: { id: "a", url: "https://private.invalid/bucket/image.png" } }]);
  f.material.mockResolvedValue({ asset: { id: "a" } });
  f.save.mockImplementation(async ({ update }) => ({ ...emptyState, ...update, workflowTarget: update.workflowTarget === "database-null" ? null : update.workflowTarget, workflowUpdatedAt: savedAt }));
  f.transaction.mockImplementation(fn => fn({ $queryRaw: f.lock, project: { findFirst: f.project }, editorDocument: { findUnique: f.document }, studioMaterialUpload: { findMany: f.materials }, workbenchProjectState: { findUnique: f.state, upsert: f.save } }));
});

describe("project-scoped durable workflow service", () => {
  it("provides truthful initial workflow state and authenticated saved-image assets", async () => {
    expect(await readStudioWorkflow("w", "u", { projectId: "p" })).toEqual({ projectId: "p", revision: 0, mode: "generate", target: null, references: [], updatedAt: null, issues: [] });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "VIEWER");
    const result = await readStudioWorkflowAssets("w", "u", { projectId: "p" });
    expect(result.assets[0]).toMatchObject({ shapeId: ref.shapeId, assetSha256: sha });
    expect(f.project).toHaveBeenCalledWith({ where: { id: "p", workspaceId: "w" }, select: { id: true } });
    expect(f.materials.mock.calls[0][0].where).toMatchObject({ workspaceId: "w", projectId: "p", task: { status: "SUCCEEDED" }, asset: { workspaceId: "w", deprecatedAt: null, projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } }, OR: [{ id: { in: ["a"] } }, { url: { in: [url] } }] } });
  });
  it("checks membership and project scope before reading workflow, canvas or upload records", async () => {
    f.gate.mockRejectedValueOnce({ status: 404 });
    await expect(readStudioWorkflow("w", "stranger", { projectId: "p" })).rejects.toMatchObject({ status: 404 });
    expect(f.transaction).not.toHaveBeenCalled();
    f.project.mockResolvedValue(null);
    await expect(readStudioWorkflow("w", "u", { projectId: "foreign" })).rejects.toMatchObject({ status: 404 });
    expect(f.state).not.toHaveBeenCalled(); expect(f.materials).not.toHaveBeenCalled(); expect(f.document).not.toHaveBeenCalled();
  });
  it("writes only workflow fields under the project row lock and preserves context/brief revisions", async () => {
    const view = await saveStudioWorkflow("w", "u", input);
    expect(view).toMatchObject({ projectId: "p", revision: 1, references: [ref], updatedAt: savedAt.getTime(), issues: [] });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "EDITOR");
    const [sql, ...values] = f.lock.mock.calls[0];
    expect(sql.join("")).toContain("FOR UPDATE"); expect(values).toEqual(["p", "w"]);
    const { create, update } = f.save.mock.calls[0][0];
    expect(create).toMatchObject({ projectId: "p", workspaceId: "w", brief: "existing brief" });
    expect(Object.keys(update).sort()).toEqual(["workflowMode", "workflowReferences", "workflowRevision", "workflowTarget", "workflowUpdatedAt"]);
    f.state.mockResolvedValue({ ...emptyState, workflowRevision: 1, workflowReferences: [ref], workflowUpdatedAt: savedAt, revision: 87, brief: "do not touch" });
    expect((await readStudioWorkflow("w", "u", { projectId: "p" })).references).toEqual([ref]);
  });
  it("rejects read-only, archived and missing projects before saving", async () => {
    f.gate.mockRejectedValueOnce({ status: 403 });
    await expect(saveStudioWorkflow("w", "viewer", input)).rejects.toMatchObject({ status: 403 });
    expect(f.transaction).not.toHaveBeenCalled();
    for (const [rows, status] of [[[], 404], [[{ archivedAt: savedAt }], 409]] as const) {
      f.lock.mockResolvedValue(rows); await expect(saveStudioWorkflow("w", "u", input)).rejects.toMatchObject({ status });
    }
    expect(f.save).not.toHaveBeenCalled(); expect(f.materials).not.toHaveBeenCalled();
  });
  it("enforces the independent workflow CAS without touching context revision", async () => {
    f.state.mockResolvedValue({ ...emptyState, workflowRevision: 2, revision: 0 });
    await expect(saveStudioWorkflow("w", "u", input)).rejects.toMatchObject({ status: 409 });
    expect(f.save).not.toHaveBeenCalled(); expect(f.materials).not.toHaveBeenCalled();
    expect((await saveStudioWorkflow("w", "u", { ...input, revision: 2 })).revision).toBe(3);
  });
  it("never authorizes a SHA without an eligible project upload and prevents new invalid selections", async () => {
    f.materials.mockResolvedValue([]);
    const view = await readStudioWorkflowAssets("w", "u", { projectId: "p" });
    expect(view.assets).toEqual([]); expect(view.issues).toMatchObject([{ code: "UNVERIFIED_MATERIAL" }]);
    await expect(saveStudioWorkflow("w", "u", input)).rejects.toMatchObject({ status: 422 });
    expect(f.save).not.toHaveBeenCalled();
  });
  it("retains unavailable stored selections with issues and allows explicit removal", async () => {
    f.state.mockResolvedValue({ ...emptyState, workflowReferences: [ref] }); f.materials.mockResolvedValue([]);
    const view = await readStudioWorkflow("w", "u", { projectId: "p" });
    expect(view.references).toEqual([ref]); expect(view.issues).toContainEqual(expect.objectContaining({ scope: "reference", code: "REFERENCE_MISSING", blocking: true }));
    expect((await saveStudioWorkflow("w", "u", input)).references).toEqual([ref]);
    expect((await saveStudioWorkflow("w", "u", { ...input, references: [] })).references).toEqual([]);
  });
  it("preserves corrupt stored state instead of replacing it with an empty success", async () => {
    for (const changed of [{ workflowReferences: null }, { workflowMode: "future-mode" }, { workspaceId: "other" }]) {
      f.state.mockResolvedValue({ ...emptyState, ...changed });
      await expect(saveStudioWorkflow("w", "u", input)).rejects.toMatchObject({ status: 409 });
    }
    expect(f.save).not.toHaveBeenCalled();
  });
  it("refuses unsupported or foreign canvas documents and returns empty assets for an unsaved project", async () => {
    f.document.mockResolvedValue({ workspaceId: "other", format: "novart-native-v1", canvas });
    await expect(readStudioWorkflowAssets("w", "u", { projectId: "p" })).rejects.toMatchObject({ status: 409 });
    f.document.mockResolvedValue(null);
    expect(await readStudioWorkflowAssets("w", "u", { projectId: "p" })).toEqual({ projectId: "p", assets: [], issues: [] });
  });
  it("only resolves thumbnails through a project-scoped material to the canonical same-origin proxy", async () => {
    expect(await studioWorkflowImage("w", "viewer", { projectId: "p" }, sha)).toBe(url);
    expect(f.gate).toHaveBeenCalledWith("w", "viewer", "VIEWER");
    expect(f.material.mock.calls[0][0].where).toMatchObject({ workspaceId: "w", projectId: "p", sha256: sha, task: { status: "SUCCEEDED" }, asset: { workspaceId: "w", deprecatedAt: null, projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } } });
    f.material.mockResolvedValue(null);
    await expect(studioWorkflowImage("w", "u", { projectId: "p" }, sha)).rejects.toMatchObject({ status: 404 });
    await expect(studioWorkflowImage("w", "u", { projectId: "p" }, "../../secret")).rejects.toThrow();
  });
});
