import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeProjectListInput, NativeProjectSaveInput } from "../src/native-project";
import { EditorDocumentError } from "../../../apps/web/src/lib/editor-document-codec";
import { nativeErrorResponse } from "../../../apps/web/src/lib/native-project-response";

const f = vi.hoisted(() => ({ gate: vi.fn(), read: vi.fn(), save: vi.fn(), find: vi.fn(), list: vi.fn(), count: vi.fn(), rename: vi.fn(), transaction: vi.fn() }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.gate }));
vi.mock("../../../apps/web/src/lib/editor-documents", () => ({ readEditorDocument: f.read, saveEditorDocument: f.save }));
vi.mock("../../db/src/index", () => ({ prisma: {
  project: { findFirst: f.find, findMany: f.list, count: f.count, updateMany: f.rename }, $transaction: f.transaction,
} }));
import { nativeDocumentMutation, queryNativeProject, saveNativeProject, listNativeProjects, renameNativeProject } from "../../../apps/web/src/lib/native-projects";

const payload = { projectId: "p", canvas: "SHAKKERDATA://encoded", version: "novart-7" };
beforeEach(() => {
  vi.resetAllMocks();
  f.gate.mockResolvedValue({ role: "EDITOR" });
  f.read.mockResolvedValue({ canvas: payload.canvas, revision: 7, updatedAt: "2026-10-08T00:00:00Z", readOnly: false });
  f.find.mockResolvedValue({ name: "Current name", createdAt: new Date("2026-10-01T00:00:00Z") });
  f.save.mockResolvedValue({ projectId: "p", revision: 8 });
  f.list.mockResolvedValue([{ id: "p", name: "Current name", createdAt: new Date("2026-10-01T00:00:00Z"), editorDocument: { revision: 7, updatedAt: new Date("2026-10-08T00:00:00Z") } }]);
  f.count.mockResolvedValue(3); f.transaction.mockImplementation(operations => Promise.all(operations));
  f.rename.mockResolvedValue({ count: 1 });
});

describe("native project compatibility", () => {
  it("rejects missing, foreign-format and out-of-range versions rather than silently saving against latest", () => {
    for (const version of [undefined, null, "local-old", "novart-01", "novart--1", "novart-2147483647", "novart-1\n"]) {
      expect(NativeProjectSaveInput.safeParse({ ...payload, version }).success).toBe(false);
    }
    expect(NativeProjectSaveInput.safeParse({ ...payload, version: "novart-2147483646" }).success).toBe(true);
  });
  it("refuses clone/evidence requests that have no product implementation", () => {
    for (const extra of [{ sourceProjectId: "other" }, { projectType: 5 }, { canvasV2Gray: true }, { canvasEvidenceEnabled: true }, { canvasEvidenceWindowId: "x" }, { picCount: null }]) {
      expect(NativeProjectSaveInput.safeParse({ ...payload, ...extra }).success).toBe(false);
    }
  });
  it("bounds project IDs and list pagination", () => {
    expect(NativeProjectSaveInput.safeParse({ ...payload, projectId: "../p" }).success).toBe(false);
    expect(NativeProjectListInput.parse({})).toEqual({ page: 1, pageSize: 20 });
    for (const input of [{ page: 0 }, { pageSize: 101 }, { page: "1" }, { page: null }]) expect(NativeProjectListInput.safeParse(input).success).toBe(false);
  });
  it("derives stable retries while separating content, version, user, project and brand", () => {
    const base = nativeDocumentMutation("u", "w", payload);
    expect(base).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(nativeDocumentMutation("u", "w", { ...payload, sessionId: "retry", projectName: "Echoed name" })).toBe(base);
    for (const [u, w, p] of [["u2", "w", payload], ["u", "w2", payload], ["u", "w", { ...payload, projectId: "p2" }], ["u", "w", { ...payload, version: "novart-8" }], ["u", "w", { ...payload, canvas: "SHAKKERDATA://other" }]] as const) {
      expect(nativeDocumentMutation(u, w, p)).not.toBe(base);
    }
  });
  it("delegates exact canvas and expected revision to the existing authorization/CAS service", async () => {
    expect(await saveNativeProject("w", "u", { ...payload, projectName: "Stale echoed name" })).toEqual({ projectId: "p", version: "novart-8", validProjectId: true });
    expect(f.save).toHaveBeenCalledWith("w", "p", "u", { format: "novart-native-v1", canvas: payload.canvas, revision: 7, mutationId: nativeDocumentMutation("u", "w", payload) });
    expect(f.rename).not.toHaveBeenCalled();
  });
  it("does not read project metadata after document access is denied", async () => {
    f.read.mockRejectedValue(new EditorDocumentError(404, "NOT_FOUND", "Not found"));
    await expect(queryNativeProject("w", "u", { projectId: "p" })).rejects.toMatchObject({ status: 404 });
    expect(f.find).not.toHaveBeenCalled();
  });
  it("returns saved content/version and server-derived read-only state", async () => {
    f.read.mockResolvedValue({ canvas: payload.canvas, revision: 7, updatedAt: null, readOnly: true });
    const project = await queryNativeProject("w", "u", { projectId: "p" });
    expect(project).toMatchObject({ canvas: payload.canvas, version: payload.version, readOnly: true, projectName: "Current name", canvasEvidenceEnabled: false });
    expect(project.updatedAt).toBe(project.createdAt);
    expect(f.find.mock.calls[0][0].where).toEqual({ id: "p", workspaceId: "w" });
  });
  it("lists only authorized unarchived projects without loading canvases", async () => {
    const result = await listNativeProjects("w", "u", { page: 1, pageSize: 2 });
    expect(result).toMatchObject({ page: 1, total: 3, hasMore: true, data: [{ projectId: "p", hasCanvas: true, version: "novart-7" }] });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "VIEWER");
    expect(f.list.mock.calls[0][0]).toMatchObject({ where: { workspaceId: "w", archivedAt: null }, take: 2, skip: 0 });
    expect(f.list.mock.calls[0][0].select.editorDocument.select).toEqual({ revision: true, updatedAt: true });
    f.gate.mockRejectedValue(new Error("Denied")); f.list.mockClear();
    await expect(listNativeProjects("w", "u", {})).rejects.toThrow("Denied"); expect(f.list).not.toHaveBeenCalled();
  });
  it("renames through a scoped, unarchived write and requires an editor", async () => {
    await renameNativeProject("w", "u", { projectId: "p", projectName: " New name " });
    expect(f.gate).toHaveBeenCalledWith("w", "u", "EDITOR");
    expect(f.rename).toHaveBeenCalledWith({ where: { id: "p", workspaceId: "w", archivedAt: null }, data: { name: "New name" } });
    f.rename.mockResolvedValue({ count: 0 });
    await expect(renameNativeProject("w", "u", { projectId: "p", projectName: "New" })).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
  });
  it("preserves the editor's conflict envelope without treating archive or validation errors as success", async () => {
    const conflict = nativeErrorResponse(new EditorDocumentError(409, "DOCUMENT_CONFLICT", "Reload"));
    expect(conflict.status).toBe(200); expect(await conflict.json()).toEqual({ code: 100400, msg: "Reload", data: null });
    expect(nativeErrorResponse(new EditorDocumentError(409, "PROJECT_ARCHIVED", "Archived")).status).toBe(409);
    const internal = await nativeErrorResponse(new Error("private-database-url")).json();
    expect(internal.code).toBe(500); expect(JSON.stringify(internal)).not.toContain("private-database-url");
  });
});
