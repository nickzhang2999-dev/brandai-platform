import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedDraftApi, createOwnedDraftSession, decodeOwnedDraft, emptyOwnedDraft, encodeOwnedDraft } from "../../../apps/web/src/components/owned-canvas/owned-draft-api";
import { NovartApiError } from "../../../apps/web/src/lib/novart-api-client";
import type { WorkbenchDraftView } from "../src/workbench-shell";

// Pure transport/state regressions with synthetic receipts, not real backend
// persistence acceptance. The actual React composer is exercised separately.
const p = "draft-project";
const value = { prompt: "中文需求\n最后一行", ratio: "16:9" as const, quality: "2K" as const, outputFrameId: "shape:output" };
const view = (revision = 0, inputForm: WorkbenchDraftView["inputForm"] = null): WorkbenchDraftView => ({ projectId: p, revision, inputForm, updatedAt: revision ? 1791552000000 : null, referenceIssues: [] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const api = (fetcher: typeof fetch) => createOwnedDraftApi("draft-workspace", p, "draft-user", { fetcher, origin: "https://novart.test" });
function fixture() {
  let remote = view();
  const read = vi.fn(async () => structuredClone(remote));
  const write = vi.fn(async (input: { revision: number; inputForm: WorkbenchDraftView["inputForm"] }, _keepalive = false) => {
    if (input.revision !== remote.revision) throw new NovartApiError("synthetic conflict", 409);
    remote = view(input.revision + 1, input.inputForm); return structuredClone(remote);
  });
  const session = createOwnedDraftSession({ read, write }, p);
  return { read, write, session, get remote() { return remote; }, setRemote(next: WorkbenchDraftView) { remote = next; } };
}
afterEach(() => vi.useRealTimers());

describe("owned composer draft form", () => {
  it("writes matching native plain text nodes, preserves harmless preferences and restores generation size/frame", () => {
    const form = encodeOwnedDraft({ text: "旧正文", model: "preferred", ratio: "1:1", quality: "1K" }, value);
    expect(form).toMatchObject({ text: value.prompt, model: "preferred", ratio: value.ratio, quality: value.quality, paramList: [], mentionPreviewList: [] });
    expect(decodeOwnedDraft(view(2, form))).toEqual(value);
    expect(decodeOwnedDraft(view(3, encodeOwnedDraft(form, { ...value, prompt: "" , outputFrameId: undefined })))).toEqual({ ...value, prompt: "", outputFrameId: undefined });
  });
  it("refuses rich, mention, inconsistent and unsupported old drafts without flattening their meaning", () => {
    const original = encodeOwnedDraft(null, value);
    const malformed = [
      { ...original, text: "different from nodes" },
      { text: "ref", paramList: [{ type: "image", data: { assetSha256: "a".repeat(64) } }] },
      { text: "ref", mentionPreviewList: [{}] },
      { text: "x", lexicalJSONState: { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "x", format: 1 }] }] } } },
      { text: "x", lexicalJSONState: { root: { type: "root", children: [{ type: "heading", children: [] }] } } },
      { text: "x", sizeSelection: { ratioKey: "custom", resolutionTier: "1K", customRatio: { width: 3, height: 5 } } },
      { text: "x".repeat(4001) },
    ];
    for (const inputForm of malformed) { const before = structuredClone(inputForm); expect(() => decodeOwnedDraft(view(1, inputForm))).toThrow(); expect(inputForm).toEqual(before); }
    expect(decodeOwnedDraft(view())).toEqual(emptyOwnedDraft());
  });
  it("does not inject workflow references, mode or provider settings into generation fields", () => {
    const form = encodeOwnedDraft({ text: "old", unrelatedPreference: "kept" }, value);
    expect(form).not.toHaveProperty("references"); expect(form).not.toHaveProperty("target"); expect(form).not.toHaveProperty("mode");
    expect(Object.keys(decodeOwnedDraft(view(1, form))).sort()).toEqual(["outputFrameId", "prompt", "quality", "ratio"]);
  });
});

describe("owned draft scoped API", () => {
  it("pins user, workspace and project; uses cookie auth, no browser storage or bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(view())); await api(fetcher).read();
    expect(fetcher.mock.calls[0]![0]).toBe("/studio/draft?workspaceId=draft-workspace&projectId=draft-project");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", headers: { "X-Novart-User": "draft-user" } });
    expect(new Headers(fetcher.mock.calls[0]![1].headers).has("authorization")).toBe(false);
  });
  it("does not accept a different project or malformed revision as a save receipt", async () => {
    const input = { projectId: p, revision: 0, inputForm: { text: "remain" } };
    await expect(api(vi.fn().mockResolvedValue(response({ ...view(1), projectId: "foreign" }))).write(input)).rejects.toMatchObject({ uncertain: true });
    await expect(api(vi.fn().mockResolvedValue(response({ ...view(), revision: -1 }))).read()).rejects.toMatchObject({ code: "DRAFT_RECEIPT" });
  });
  it("keeps the deadline alive during response body decode", async () => {
    vi.useFakeTimers(); let aborted = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({ start(stream) { init?.signal?.addEventListener("abort", () => { aborted = true; stream.error(new Error("synthetic timeout")); }); } })));
    const pending = api(fetcher).write({ projectId: p, revision: 0, inputForm: { text: "keep" } });
    const assertion = expect(pending).rejects.toMatchObject({ uncertain: true, status: null });
    await vi.advanceTimersByTimeAsync(15001); await assertion; expect(aborted).toBe(true);
  });
  it("only uses bounded keepalive payloads and treats failed delivery as uncertain", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("synthetic network loss"));
    await expect(api(fetcher).write({ projectId: p, revision: 0, inputForm: { text: "keep" } }, true)).rejects.toMatchObject({ uncertain: true });
    expect(fetcher.mock.calls[0]![1].keepalive).toBe(true);
    const tooLarge = vi.fn(); await expect(api(tooLarge).write({ projectId: p, revision: 0, inputForm: { text: "中".repeat(21000) } }, true)).rejects.toMatchObject({ code: "DRAFT_CLOSE_SIZE" }); expect(tooLarge).not.toHaveBeenCalled();
  });
});

describe("owned draft revision session", () => {
  it("never saves defaults if restoration fails", async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new Error("synthetic restore failure"));
    await expect(f.session.load()).rejects.toThrow(); f.session.edit(value); await expect(f.session.flush()).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled(); expect(f.session.snapshot()).toMatchObject({ ready: false, blocked: true, state: "error" });
    await f.session.load(); f.session.edit(value); expect(await f.session.flush()).toEqual(value); expect(f.remote.revision).toBe(1);
  });
  it("restores old drafts without writing and protects unsupported references", async () => {
    const f = fixture(); f.setRemote(view(4, encodeOwnedDraft(null, value))); expect(await f.session.load()).toEqual(value); expect(f.write).not.toHaveBeenCalled();
    const g = fixture(); g.setRemote(view(4, { text: "old", paramList: [{}] })); await expect(g.session.load()).rejects.toThrow();
    expect(g.session.snapshot()).toMatchObject({ state: "unsupported", blocked: true }); await expect(g.session.flush()).rejects.toThrow(); expect(g.write).not.toHaveBeenCalled();
  });
  it("saves the latest edits made during an earlier in-flight save", async () => {
    const f = fixture(); await f.session.load(); f.session.edit(value);
    let release!: () => void; const normal = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async input => { await new Promise<void>(resolve => { release = resolve; }); return normal(input); });
    const pending = f.session.flush(); f.session.edit({ ...value, prompt: "newest" }); release();
    expect((await pending).prompt).toBe("newest"); expect(f.remote.revision).toBe(2); expect(f.remote.inputForm?.text).toBe("newest");
  });
  it("confirms a lost response through exact server read without a duplicate write", async () => {
    const f = fixture(); await f.session.load(); f.session.edit(value);
    const normal = f.write.getMockImplementation()!; f.write.mockImplementationOnce(async input => { await normal(input); throw new NovartApiError("lost", null, undefined, true); });
    await expect(f.session.flush()).rejects.toThrow(); expect(f.session.snapshot().dirty).toBe(true);
    expect(await f.session.flush()).toEqual(value); expect(f.write).toHaveBeenCalledTimes(1); expect(f.session.snapshot()).toMatchObject({ state: "saved", dirty: false, revision: 1 });
  });
  it("retries exact original payload when no save was accepted, then saves later edits", async () => {
    const f = fixture(); await f.session.load(); f.session.edit(value); f.write.mockRejectedValueOnce(new NovartApiError("lost", null, undefined, true));
    await expect(f.session.flush()).rejects.toThrow(); f.session.edit({ ...value, prompt: "later" }); await f.session.flush();
    expect(f.write.mock.calls[0]![0]).toEqual(f.write.mock.calls[1]![0]); expect(f.write.mock.calls[2]![0].revision).toBe(1); expect(f.remote.inputForm?.text).toBe("later");
  });
  it("blocks conflicts and retains local input instead of adopting a newer remote draft", async () => {
    const f = fixture(); await f.session.load(); f.session.edit(value); f.setRemote(view(1, { text: "other page" }));
    await expect(f.session.flush()).rejects.toMatchObject({ status: 409 }); expect(f.session.snapshot()).toMatchObject({ state: "conflict", blocked: true, dirty: true, value });
    await expect(f.session.flush()).rejects.toThrow(); await expect(f.session.load()).rejects.toThrow(); expect(f.remote.inputForm?.text).toBe("other page"); expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("does not turn a same-text newer foreign save into confirmation of an uncertain request", async () => {
    const f = fixture(); await f.session.load(); f.session.edit(value); f.write.mockRejectedValueOnce(new NovartApiError("lost", null, undefined, true)); await expect(f.session.flush()).rejects.toThrow();
    f.setRemote(view(3, encodeOwnedDraft(null, value))); await expect(f.session.flush()).rejects.toMatchObject({ status: 409 }); expect(f.session.snapshot().dirty).toBe(true);
  });
  it("rejects malformed successful save receipts and requires rechecking before claiming saved", async () => {
    const f = fixture(); await f.session.load(); f.session.edit(value); f.write.mockResolvedValueOnce(view(1, { text: "wrong" }));
    await expect(f.session.flush()).rejects.toMatchObject({ uncertain: true }); expect(f.session.snapshot().dirty).toBe(true); expect(await f.session.flush()).toEqual(value);
  });
  it("does not write on a clean page close and does keepalive flush on an edited one", async () => {
    const f = fixture(); await f.session.load(); await f.session.flush(true); expect(f.write).not.toHaveBeenCalled();
    f.session.edit(value); await f.session.flush(true); expect(f.write.mock.calls[0]?.[1]).toBe(true);
  });
});
