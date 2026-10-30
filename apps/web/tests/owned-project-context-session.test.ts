import { describe, expect, it, vi } from "vitest";
import { NovartApiError } from "../src/lib/novart-api-client";
import { createOwnedEditorApi, type ProjectContext, type ProjectContextInput } from "../src/components/owned-canvas/owned-editor-api";
import { createOwnedProjectContextSession, hasProjectContext } from "../src/components/owned-canvas/owned-project-context-session";

const clone = <T,>(value: T): T => structuredClone(value);
const original = (): ProjectContext => ({ projectId: "project-a", revision: 2,
  facts: { goal: "推广茶饮", audience: "年轻人", approvedCopy: "新口味上市", visualRequirements: "保留品牌紫色" }, materials: [], master: null, updatedAt: "2026-10-30T00:00:00.000Z", issues: [] });
function fixture() {
  let server = original(), writable = true;
  const api = {
    readProjectContext: vi.fn(async () => clone(server)),
    saveProjectContext: vi.fn(async (input: ProjectContextInput) => {
      server = { ...server, revision: input.expectedRevision + 1, facts: clone(input.facts),
        materials: input.materials.map(value => ({ ...value, name: "素材", width: 12, height: 8, versionId: null })),
        master: input.master ? { ...input.master, shapeId: input.master.shapeId ?? null, versionId: input.master.versionId ?? null, name: "主稿", width: 12, height: 8 } : null };
      return clone(server);
    }),
  };
  const saveDocument = vi.fn(async () => 9), session = createOwnedProjectContextSession(api, { canWrite: () => writable, saveDocument });
  return { api, session, saveDocument, get server() { return server; }, set server(value: ProjectContext) { server = value; }, set writable(value: boolean) { writable = value; } };
}
const edit = (f: ReturnType<typeof fixture>, text = "春季新品") => f.session.change(value => ({ ...value, facts: { ...value.facts, goal: text } }));

describe("confirmed project context", () => {
  it("restores confirmed facts without a local write and detects an empty project", async () => {
    const f = fixture(); await f.session.load(); expect(f.session.snapshot().draft?.facts).toEqual(f.server.facts);
    expect(f.api.saveProjectContext).not.toHaveBeenCalled(); expect(hasProjectContext(f.server)).toBe(true);
    expect(hasProjectContext({ ...f.server, facts: { goal: "", audience: "", approvedCopy: "", visualRequirements: "" } })).toBe(false);
  });
  it("saves a selected master against the saved canvas without creating an edit target", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, master: { assetId: "asset-a", assetSha256: "a".repeat(64), shapeId: "shape:a" } }));
    await f.session.save(); expect(f.saveDocument).toHaveBeenCalledOnce();
    expect(f.api.saveProjectContext.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 2, documentRevision: 9, master: { shapeId: "shape:a" } });
    expect(f.session.snapshot()).toMatchObject({ dirty: false, status: "ready", server: { revision: 3 } });
  });
  it("blocks unsaved facts and changed source images from model context", async () => {
    const f = fixture(); await f.session.load(); edit(f); await expect(f.session.confirmForUse()).rejects.toThrow("保存");
    await f.session.save(); f.server.issues = [{ scope: "master", assetId: "asset-a", code: "SOURCE_CHANGED", message: "来源变化" }];
    await expect(f.session.confirmForUse()).rejects.toThrow("来源已变化"); expect(f.session.snapshot().server?.issues).toHaveLength(1);
  });
  it("reads the server again before freezing the next conversation revision", async () => {
    const f = fixture(); await f.session.load(); expect((await f.session.confirmForUse()).revision).toBe(2); expect(f.api.readProjectContext).toHaveBeenCalledTimes(2);
    f.server = { ...f.server, revision: 3, facts: { ...f.server.facts, goal: "同事更新" } };
    await expect(f.session.confirmForUse()).rejects.toMatchObject({ status: 409 }); expect(f.session.snapshot().draft?.facts.goal).toBe("推广茶饮");
  });
  it("preserves edits on conflict, and requires explicit rebase then another save", async () => {
    const f = fixture(); await f.session.load(); edit(f);
    f.server = { ...f.server, revision: 3, facts: { ...f.server.facts, goal: "其他目标" } };
    f.api.saveProjectContext.mockRejectedValueOnce(new NovartApiError("其他人更新", 409));
    await expect(f.session.save()).rejects.toMatchObject({ status: 409 }); expect(f.session.snapshot().draft?.facts.goal).toBe("春季新品");
    f.session.resolveConflict("local"); expect(f.session.snapshot()).toMatchObject({ dirty: true, server: { revision: 3 } });
    await expect(f.session.confirmForUse()).rejects.toThrow(); await f.session.save(); expect(f.api.saveProjectContext.mock.calls[1]?.[0].expectedRevision).toBe(3);
  });
  it("adopts the server only after the user chooses it", async () => {
    const f = fixture(); await f.session.load(); edit(f); f.server = { ...f.server, revision: 3, facts: { ...f.server.facts, goal: "同事目标" } };
    await f.session.load(); expect(f.session.snapshot().status).toBe("conflict"); f.session.resolveConflict("server");
    expect(f.session.snapshot()).toMatchObject({ dirty: false, draft: { facts: { goal: "同事目标" } } });
  });
  it("acknowledges a lost save by reading the exact next revision without another write", async () => {
    const f = fixture(); await f.session.load(); edit(f); const write = f.api.saveProjectContext.getMockImplementation()!;
    f.api.saveProjectContext.mockImplementationOnce(async input => { await write(input); throw new NovartApiError("连接中断", null, undefined, true); });
    await expect(f.session.save()).rejects.toThrow(); expect(f.session.snapshot().status).toBe("uncertain");
    expect(() => edit(f, "另一需求")).toThrow("确认"); await f.session.save(); expect(f.api.saveProjectContext).toHaveBeenCalledOnce();
  });
  it("reuses the same mutation and frozen source revision after an uncommitted lost save", async () => {
    const f = fixture(); await f.session.load(); edit(f); f.api.saveProjectContext.mockRejectedValueOnce(new NovartApiError("连接中断", null, undefined, true));
    await expect(f.session.save()).rejects.toThrow(); await f.session.save();
    expect(f.api.saveProjectContext.mock.calls[1]?.[0]).toEqual(f.api.saveProjectContext.mock.calls[0]?.[0]);
  });
  it("does not send a late save or display an old load after switching project", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, master: { assetId: "asset-a", assetSha256: "a".repeat(64), shapeId: "shape:a" } }));
    let finish!: (value: number) => void; f.saveDocument.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const operation = f.session.save(); f.session.dispose(); finish(9); await expect(operation).rejects.toThrow("项目已切换"); expect(f.api.saveProjectContext).not.toHaveBeenCalled();
    const fresh = fixture(); let read!: (value: ProjectContext) => void; fresh.api.readProjectContext.mockImplementationOnce(() => new Promise(resolve => { read = resolve; }));
    const load = fresh.session.load(); fresh.session.dispose(); read(original()); await load; expect(fresh.session.snapshot().server).toBeNull();
  });
  it("keeps read-only contexts viewable and caps responsibility references", async () => {
    const f = fixture(); f.writable = false; await f.session.load(); expect(f.session.snapshot().server).not.toBeNull(); expect(() => edit(f)).toThrow("只读");
    f.writable = true; expect(() => f.session.change(value => ({ ...value, materials: Array.from({ length: 8 }, (_, n) => ({ assetId: `asset-${n}`, assetSha256: "a".repeat(64), role: "STYLE" })) }))).toThrow("7 张");
  });
  it("reports load failure without inventing project facts", async () => {
    const f = fixture(); f.api.readProjectContext.mockRejectedValueOnce(new Error("资料读取失败")); await f.session.load();
    expect(f.session.snapshot()).toMatchObject({ status: "error", server: null }); await expect(f.session.confirmForUse()).rejects.toThrow();
  });
});

describe("project context API scope", () => {
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  it("uses cookie-authenticated scoped GET/PUT and rejects a foreign project receipt", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(original())).mockResolvedValueOnce(response({ ...original(), projectId: "foreign" }));
    const api = createOwnedEditorApi("workspace-a", "project-a", "user-a", { fetcher, origin: "https://fixture.test" });
    await api.readProjectContext(); expect(fetcher.mock.calls[0]?.[0]).toBe("/api/workspaces/workspace-a/projects/project-a/studio-project-context?workspaceId=workspace-a");
    expect(fetcher.mock.calls[0]?.[1].credentials).toBe("same-origin"); await expect(api.readProjectContext()).rejects.toMatchObject({ status: 422 });
  });
  it("treats an incomplete accepted save as uncertain and retains its idempotency payload", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ revision: 3 }));
    const api = createOwnedEditorApi("workspace-a", "project-a", "user-a", { fetcher, origin: "https://fixture.test" });
    const input = { mutationId: crypto.randomUUID(), expectedRevision: 2, facts: original().facts, materials: [], master: null };
    await expect(api.saveProjectContext(input)).rejects.toMatchObject({ uncertain: true }); expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual(input);
  });
  it.each(["facts", "role", "master"])("does not acknowledge a valid-shaped but mismatched %s save receipt", async mismatch => {
    const input: ProjectContextInput = { mutationId: crypto.randomUUID(), expectedRevision: 2, facts: original().facts,
      materials: [{ assetId: "asset-a", assetSha256: "a".repeat(64), role: "PRODUCT" }], master: null };
    const saved: ProjectContext = { ...original(), revision: 3, materials: [{ ...input.materials[0]!, name: "产品", width: 12, height: 8, versionId: null }] };
    if (mismatch === "facts") saved.facts = { ...saved.facts, goal: "错误资料" };
    if (mismatch === "role") saved.materials[0]!.role = "STYLE";
    if (mismatch === "master") saved.master = { assetId: "asset-a", assetSha256: "a".repeat(64), shapeId: null, versionId: null, name: "错误主稿", width: 12, height: 8 };
    const api = createOwnedEditorApi("workspace-a", "project-a", "user-a", { fetcher: vi.fn().mockResolvedValue(response(saved)), origin: "https://fixture.test" });
    await expect(api.saveProjectContext(input)).rejects.toMatchObject({ uncertain: true, code: "INVALID_RECEIPT" });
  });
});
