import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  gate: vi.fn(), project: vi.fn(), lock: vi.fn(), read: vi.fn(), write: vi.fn(), assets: vi.fn(), versions: vi.fn(), transaction: vi.fn(),
}));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../../db/src/index", () => ({
  prisma: { project: { findFirst: f.project }, $transaction: f.transaction },
  Prisma: { TransactionIsolationLevel: { ReadCommitted: "ReadCommitted" } },
}));
import { readEditorDocument, saveEditorDocument } from "../../../apps/web/src/lib/editor-documents";

const input = (url?: string) => ({
  format: "novart-native-v1", revision: 0, mutationId: "ad2cb954-07f8-47af-a19f-dfc253364604",
  canvas: "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store: {
    ...(url ? { "shape:image": { typeName: "shape", type: "c-image", props: { url } } } : {}),
  } } } })).toString("base64"),
});
beforeEach(() => {
  vi.resetAllMocks();
  f.gate.mockResolvedValue({ role: "OWNER" });
  f.lock.mockResolvedValue([{ id: "p", archivedAt: null }]);
  f.read.mockResolvedValue(null); f.assets.mockResolvedValue([]); f.versions.mockResolvedValue([]);
  f.project.mockResolvedValue({ id: "p", archivedAt: null, editorDocument: null });
  f.transaction.mockImplementation(fn => fn({ $queryRaw: f.lock, editorDocument: { findUnique: f.read, upsert: f.write }, asset: { findMany: f.assets }, generationVersion: { findMany: f.versions } }));
  f.write.mockImplementation(({ create }) => ({ ...create, updatedAt: new Date("2026-10-08T00:00:00Z") }));
});

describe("document service authorization and persistence", () => {
  it("checks membership before reading project data", async () => {
    f.gate.mockRejectedValue(new Error("Forbidden"));
    await expect(readEditorDocument("w", "p", "outsider")).rejects.toThrow("Forbidden");
    expect(f.project).not.toHaveBeenCalled();
  });
  it("requires EDITOR for writes, never accepting a viewer's save", async () => {
    f.gate.mockRejectedValue(new Error("Forbidden"));
    await expect(saveEditorDocument("w", "p", "viewer", input())).rejects.toThrow();
    expect(f.gate).toHaveBeenCalledWith("w", "viewer", "EDITOR");
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("reads projects with an explicit workspace filter and reflects viewer/archived state", async () => {
    f.gate.mockResolvedValue({ role: "VIEWER" });
    expect((await readEditorDocument("w", "p", "viewer")).readOnly).toBe(true);
    expect(f.project.mock.calls[0][0].where).toEqual({ id: "p", workspaceId: "w" });
    f.gate.mockResolvedValue({ role: "OWNER" }); f.project.mockResolvedValue({ archivedAt: new Date(), editorDocument: null });
    expect((await readEditorDocument("w", "p", "owner")).readOnly).toBe(true);
  });
  it("checks archive state after locking the project and does not write", async () => {
    f.lock.mockResolvedValue([{ id: "p", archivedAt: new Date() }]);
    await expect(saveEditorDocument("w", "p", "owner", input())).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(f.write).not.toHaveBeenCalled();
  });
  it("rejects a missing or foreign project at the locked query", async () => {
    f.lock.mockResolvedValue([]);
    await expect(saveEditorDocument("w", "p", "owner", input())).rejects.toMatchObject({ status: 404 });
    expect(f.write).not.toHaveBeenCalled();
  });
  it("rejects a foreign embedded asset and retains the previous document", async () => {
    await expect(saveEditorDocument("w", "p", "owner", input("/api/workspaces/other/assets/a/raw"))).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
    expect(f.assets.mock.calls[0][0].where.workspaceId).toBe("w");
    expect(f.versions.mock.calls[0][0].where.generation).toEqual({ workspaceId: "w", projectId: "p" });
    expect(f.write).not.toHaveBeenCalled();
  });
  it("stores exact encoded data and its revision after validating references", async () => {
    f.assets.mockResolvedValue([{ id: "a", url: "https://storage.invalid/real" }]);
    const payload = input("/api/workspaces/w/assets/a/raw");
    const result = await saveEditorDocument("w", "p", "owner", payload);
    expect(result.canvas).toBe(payload.canvas); expect(result.revision).toBe(1);
    expect(f.write.mock.calls[0][0].create.updatedById).toBe("owner");
  });
});
