import { describe, expect, it, vi } from "vitest";
import { NovartApiError } from "../../../apps/web/src/lib/novart-api-client";
import { createOwnedEditorApi, type Workflow, type WorkflowInput } from "../../../apps/web/src/components/owned-canvas/owned-editor-api";
import { createOwnedWorkflowSession, workflowSelection } from "../../../apps/web/src/components/owned-canvas/owned-workflow-session";

const target = { shapeId: "shape:target", assetSha256: "a".repeat(64) };
const reference = { shapeId: "shape:reference", assetSha256: "b".repeat(64), purpose: "EXACT" as const, participates: true };
const original = (): Workflow => ({ projectId: "project-a", revision: 3, mode: "modify", target: { ...target }, references: [{ ...reference }], updatedAt: 100, issues: [] });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const fixture = () => {
  let server = original(), writable = true;
  const writes: WorkflowInput[] = [];
  const api = {
    readWorkflow: vi.fn(async () => clone(server)),
    workflowAssets: vi.fn(async () => ({ projectId: server.projectId, assets: [target, reference].map((item, index) => ({ shapeId: item.shapeId, assetSha256: item.assetSha256, name: "图片 " + index, valid: true, width: 10, height: 20, mime: "image/png" })), issues: [] })),
    saveWorkflow: vi.fn(async (input: WorkflowInput) => { writes.push(clone(input)); server = { ...clone(input), revision: input.revision + 1, updatedAt: 101, issues: [] }; return clone(server); }),
  };
  const saveDocument = vi.fn(async () => {});
  const session = createOwnedWorkflowSession(api, { canWrite: () => writable, saveDocument });
  return { api, session, writes, saveDocument, get server() { return server; }, set server(next: Workflow) { server = next; }, set writable(next: boolean) { writable = next; } };
};

describe("owned workflow revision and input protection", () => {
  it("restores modify targets, inactive references and original purposes without rewriting", async () => {
    const f = fixture(); f.server.references[0]!.participates = false; await f.session.load();
    expect(f.session.snapshot().draft).toMatchObject({ mode: "modify", target, references: [{ ...reference, participates: false }] });
    expect(f.writes).toHaveLength(0); expect(f.session.snapshot().dirty).toBe(false);
  });
  it("saves the document before changed usage and preserves target/SHA identity", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, references: value.references.map(ref => ({ ...ref, purpose: "ADAPTIVE" })) }));
    f.api.saveWorkflow.mockImplementationOnce(async input => { expect(f.saveDocument).toHaveBeenCalledOnce(); f.writes.push(clone(input)); return { ...input, revision: 4, updatedAt: 102, issues: [] }; });
    await f.session.save(); expect(f.writes[0]).toMatchObject({ revision: 3, mode: "modify", target, references: [{ ...reference, purpose: "ADAPTIVE" }] });
    expect(f.session.snapshot()).toMatchObject({ dirty: false, status: "ready" });
  });
  it("keeps an invalid old reference when disabling participation instead of dropping it", async () => {
    const f = fixture(); f.api.workflowAssets.mockResolvedValue({ projectId: "project-a", assets: [], issues: [] });
    f.server.issues = [{ code: "REFERENCE_MISSING", scope: "reference", shapeId: reference.shapeId, assetSha256: reference.assetSha256, message: "原引用已删除", blocking: true, index: 0 }];
    await f.session.load(); f.session.change(value => ({ ...value, references: value.references.map(ref => ({ ...ref, participates: false })) })); await f.session.save();
    expect(f.writes[0]!.references).toEqual([{ ...reference, participates: false }]);
  });
  it("keeps local choices on refresh conflict and rebases only after an explicit choice", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, mode: "generate", target: null }));
    f.server = { ...f.server, revision: 4, references: [] }; await f.session.load();
    expect(f.session.snapshot()).toMatchObject({ status: "conflict", draft: { revision: 3, mode: "generate", references: [reference] }, latest: { revision: 4, references: [] } });
    await expect(f.session.save()).rejects.toThrow("冲突"); expect(f.writes).toHaveLength(0);
    f.session.resolveConflict("local"); expect(f.writes).toHaveLength(0); expect(f.session.snapshot()).toMatchObject({ dirty: true, draft: { revision: 4, mode: "generate", references: [reference] } });
    await f.session.save(); expect(f.writes[0]!.revision).toBe(4);
  });
  it("can explicitly adopt the server version after reviewing a conflict", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, references: [] })); f.server = { ...f.server, revision: 5 }; await f.session.load();
    f.session.resolveConflict("server"); expect(f.session.snapshot()).toMatchObject({ status: "ready", dirty: false, draft: { revision: 5, references: [reference] } }); expect(f.writes).toHaveLength(0);
  });
  it("confirms a lost committed reply by exact next revision without posting again", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, references: [] }));
    f.api.saveWorkflow.mockImplementationOnce(async input => { f.writes.push(clone(input)); f.server = { ...input, revision: input.revision + 1, updatedAt: 102, issues: [] }; throw new NovartApiError("lost reply", null, undefined, true); });
    await expect(f.session.save()).rejects.toThrow("lost reply"); expect(f.session.snapshot().status).toBe("uncertain"); expect(() => f.session.change(value => value)).toThrow("确认");
    await f.session.save(); expect(f.writes).toHaveLength(1); expect(f.session.snapshot()).toMatchObject({ status: "ready", dirty: false, server: { revision: 4, references: [] } });
  });
  it("retries an uncommitted uncertain write only after reading the unchanged old revision", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, references: [] }));
    f.api.saveWorkflow.mockRejectedValueOnce(new NovartApiError("network interrupted", null, undefined, true));
    await expect(f.session.save()).rejects.toThrow(); const first = clone(f.api.saveWorkflow.mock.calls[0]![0]); await f.session.save();
    expect(f.api.readWorkflow).toHaveBeenCalledTimes(2); expect(f.api.saveWorkflow.mock.calls[1]![0]).toEqual(first); expect(f.session.snapshot().dirty).toBe(false);
  });
  it("does not mistake matching contents at a later revision for the lost acknowledgement", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, references: [] }));
    f.api.saveWorkflow.mockRejectedValueOnce(new NovartApiError("lost", null, undefined, true)); await expect(f.session.save()).rejects.toThrow();
    f.server = { ...f.server, revision: 7, references: [] }; await expect(f.session.save()).rejects.toMatchObject({ status: 409 });
    expect(f.api.saveWorkflow).toHaveBeenCalledOnce(); expect(f.session.snapshot()).toMatchObject({ status: "conflict", dirty: true, draft: { revision: 3 }, latest: { revision: 7 } });
  });
  it("refuses a workflow write if the document becomes read-only while saving", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, references: [] })); f.saveDocument.mockImplementationOnce(async () => { f.writable = false; });
    await expect(f.session.save()).rejects.toThrow("只读"); expect(f.api.saveWorkflow).not.toHaveBeenCalled(); expect(f.session.snapshot().draft!.references).toEqual([]);
  });
  it("does not prepare generation with dirty, stale or blocking server selections", async () => {
    const f = fixture(); await f.session.load(); f.session.change(value => ({ ...value, references: [] })); await expect(f.session.confirmForGeneration()).rejects.toThrow("保存");
    await f.session.save(); f.server = { ...f.server, revision: 5 }; await expect(f.session.confirmForGeneration()).rejects.toMatchObject({ status: 409 });
    f.session.resolveConflict("server"); f.server.issues = [{ code: "TARGET_MISSING", scope: "target", ...target, message: "目标图片已删除", blocking: true }]; await expect(f.session.confirmForGeneration()).rejects.toThrow("目标图片已删除");
    expect(f.session.snapshot().draft!.target).toEqual(target);
  });
  it("suppresses old-project asynchronous updates after disposal", async () => {
    const f = fixture(); let finish!: (value: Workflow) => void;
    f.api.readWorkflow.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const report = vi.fn(); f.session.subscribe(report); const waiting = f.session.load(); f.session.dispose(); const count = report.mock.calls.length;
    finish(original()); await waiting; expect(report).toHaveBeenCalledTimes(count); expect(f.writes).toHaveLength(0);
  });
});

describe("owned workflow and notification API receipts", () => {
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const api = (fetcher: typeof fetch) => createOwnedEditorApi("workspace-a", "project-a", "user-a", { fetcher, origin: "https://novart.invalid" });
  it("rejects another project's workflow asset list", async () => {
    await expect(api(vi.fn(async () => response({ projectId: "other", assets: [], issues: [] }))).workflowAssets()).rejects.toMatchObject({ status: 422 });
  });
  it("pins workflow POST to identity and verifies the exact next-revision result", async () => {
    const input = { projectId: "project-a", revision: 3, mode: "modify" as const, target, references: [reference] };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ ...original(), revision: 4 })); const saved = await api(fetcher).saveWorkflow(input);
    expect(workflowSelection(saved)).toBe(workflowSelection(input)); expect(fetcher.mock.calls[0]![0]).toBe("/workflow?projectId=project-a&workspaceId=workspace-a");
    const init = fetcher.mock.calls[0]![1] as RequestInit; expect(new Headers(init.headers).get("X-Novart-User")).toBe("user-a"); expect(JSON.parse(init.body as string)).toEqual(input);
    await expect(api(vi.fn(async () => response({ ...original(), revision: 8 }))).saveWorkflow(input)).rejects.toMatchObject({ code: "INVALID_RECEIPT", uncertain: true });
  });
  it("refuses a generation notification receipt for a different task", async () => {
    const task = { mode: "modify", requestId: "other", mutationId: "4b106a7f-d393-49c2-a396-511d8f010101", projectId: "project-a", generationId: "generation-a", status: "PENDING", progress: null, expiresAt: "2099-01-01T00:00:00.000Z", archiveExpiresAt: null, archiveProcessingExpiresAt: null, displayText: "existing request", resultState: "NOT_REQUESTED", results: [], error: null, archiveError: null, canRetryArchive: false };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(task)); await expect(api(fetcher).getGeneration("wanted")).rejects.toMatchObject({ status: 422 }); expect(fetcher.mock.calls[0]![1]?.method).toBeUndefined();
  });
});
