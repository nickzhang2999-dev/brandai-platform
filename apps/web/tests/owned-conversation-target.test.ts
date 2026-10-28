import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioConversationDraftInput, type StudioConversationReference } from "@brandai/contracts";
import { chooseOwnedConversationTarget, ownedConversationSizePreview, requireOwnedConversationTargetEditable } from "../src/components/owned-canvas/owned-conversation-references";

const ref = (id: string, extra: Partial<StudioConversationReference> = {}): StudioConversationReference => ({
  referenceId: "shape:" + id, shapeId: "shape:" + id, name: "图片" + id, assetId: "asset-" + id,
  assetSha256: "a".repeat(64), width: 1200, height: 900, purpose: "REFERENCE", ...extra,
});
const draft = (extra: Partial<StudioConversationDraftInput> = {}) => StudioConversationDraftInput.parse({
  revision: 0, text: "把背景改成蓝色", references: [], quickEditTargetId: null,
  sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, ...extra,
});
afterEach(() => vi.unstubAllGlobals());

describe("canvas-selected conversation target", () => {
  it("selects and replaces only the owned target while independent references survive, with no request", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const original = draft({ references: [ref("reference"), ref("exact", { purpose: "EXACT" })] });
    const a = chooseOwnedConversationTarget(original, ref("a"), null);
    expect(a.quickEditTargetId).toBe("shape:a"); expect(a.ownedTargetId).toBe("shape:a");
    const b = chooseOwnedConversationTarget(a, ref("b"), a.ownedTargetId);
    expect(b.references.map(value => value.assetId)).toEqual(["asset-reference", "asset-exact", "asset-b"]);
    expect(b.references[1]!.purpose).toBe("EXACT"); expect(b.quickEditTargetId).toBe("shape:b");
    const cleared = chooseOwnedConversationTarget(b, null, b.ownedTargetId);
    expect(cleared.references).toEqual(original.references); expect(cleared.quickEditTargetId).toBeNull();
    expect(original.references).toHaveLength(2); expect(fetcher).not.toHaveBeenCalled();
    expect(StudioConversationDraftInput.safeParse({ ...original, ...b, ownedTargetId: undefined }).success).toBe(false); // bookkeeping is deliberately not a server field
    expect(StudioConversationDraftInput.safeParse({ ...original, references: b.references, quickEditTargetId: b.quickEditTargetId }).success).toBe(true);
  });
  it("preserves explicitly promoted references and conservatively retains restored targets", () => {
    const original = draft({ references: [ref("a"), ref("b", { purpose: "ADAPTIVE" })] });
    const promoted = chooseOwnedConversationTarget(original, ref("b"), null);
    expect(promoted.ownedTargetId).toBeNull(); expect(promoted.references[1]!.purpose).toBe("ADAPTIVE");
    const next = chooseOwnedConversationTarget(promoted, ref("c"), promoted.ownedTargetId);
    expect(next.references.map(value => value.assetId)).toEqual(["asset-a", "asset-b", "asset-c"]);
    const restored = draft({ references: [ref("a")], quickEditTargetId: "shape:a" });
    expect(chooseOwnedConversationTarget(restored, ref("b"), null).references).toHaveLength(2);
  });
  it("preserves target for the next turn and keeps draft text/settings unchanged", () => {
    const original = draft({ text: "让光影更自然", sizeSelection: { ratioKey: "3:4", resolutionTier: "2K" } });
    const chosen = chooseOwnedConversationTarget(original, ref("a"), null);
    const nextTurn = { ...original, references: chosen.references, quickEditTargetId: chosen.quickEditTargetId, text: "" };
    expect(nextTurn.quickEditTargetId).toBe("shape:a");
    const repeat = chooseOwnedConversationTarget(nextTurn, ref("a"), chosen.ownedTargetId);
    expect(repeat).toEqual(chosen); expect(original.text).toBe("让光影更自然"); expect(nextTurn.sizeSelection).toEqual(original.sizeSelection);
  });
  it("promotes an imported asset only after a persisted canvas receipt, retaining purpose and version", () => {
    const { shapeId: _unused, ...asset } = ref("a", { referenceId: "brand:asset-a", purpose: "ADAPTIVE" });
    const original = draft({ references: [asset] });
    expect(() => chooseOwnedConversationTarget(original, asset, null)).toThrow("放入画布");
    const placed = chooseOwnedConversationTarget(original, ref("a", { versionId: "version-a" }), null);
    expect(placed.references).toEqual([ref("a", { purpose: "ADAPTIVE", versionId: "version-a" })]);
    expect(placed.ownedTargetId).toBeNull();
  });
  it("never downgrades EXACT or removes an EXACT rule when clearing an old target", () => {
    const exact = ref("a", { purpose: "EXACT" });
    expect(() => chooseOwnedConversationTarget(draft({ references: [exact] }), ref("a"), null)).toThrow("严格保留");
    expect(() => chooseOwnedConversationTarget(draft(), exact, null)).toThrow("严格保留");
    expect(chooseOwnedConversationTarget(draft({ references: [exact], quickEditTargetId: exact.referenceId }), null, exact.referenceId).references).toEqual([exact]);
  });
  it("fails atomically for conflicting receipts or full independent-reference capacity", () => {
    const original = draft({ references: [ref("a", { versionId: "v1" })] });
    expect(() => chooseOwnedConversationTarget(original, ref("a", { versionId: "v2" }), null)).toThrow("版本已变化");
    expect(() => chooseOwnedConversationTarget(original, ref("a", { assetSha256: "b".repeat(64) }), null)).toThrow("版本已变化");
    const full = draft({ references: "abcdefgh".split("").map(id => ref(id)) });
    expect(() => chooseOwnedConversationTarget(full, ref("i"), null)).toThrow("8 张");
    expect(full.references).toHaveLength(8);
    const targetFull = { ...full, quickEditTargetId: "shape:h" };
    expect(chooseOwnedConversationTarget(targetFull, ref("i"), "shape:h").references).toHaveLength(8);
  });
  it.each([
    [{ ready: false, readOnly: false, submitting: false, uncertain: false }, "恢复"],
    [{ ready: true, readOnly: true, submitting: false, uncertain: false }, "只读"],
    [{ ready: true, readOnly: false, submitting: true, uncertain: false }, "正在提交"],
    [{ ready: true, readOnly: false, submitting: false, uncertain: true }, "原任务"],
  ])("blocks target changes at the real submission/recovery boundary", (state, reason) => {
    expect(() => requireOwnedConversationTargetEditable(state)).toThrow(reason);
    expect(() => requireOwnedConversationTargetEditable({ ready: true, readOnly: false, submitting: false, uncertain: false })).not.toThrow();
  });
});

describe("honest pre-submit dimensions from existing server rules", () => {
  it("shows original target pixels even when controls select 2K", () => {
    const value = draft({ references: [ref("a")], quickEditTargetId: "shape:a", sizeSelection: { ratioKey: "3:4", resolutionTier: "2K" } });
    expect(ownedConversationSizePreview(value)).toEqual({ source: "target", text: "保留修改对象原图：1200 × 900 像素" });
    expect(ownedConversationSizePreview({ ...value, text: "" })).toMatchObject({ source: "target", text: expect.stringContaining("1200 × 900") });
  });
  it("gives explicit pixels precedence, then text ratio/tier, then controls for a new image", () => {
    const value = draft({ references: [ref("a")], quickEditTargetId: "shape:a" });
    expect(ownedConversationSizePreview({ ...value, text: "背景改为蓝色，1080×1920" })).toEqual({ source: "dialog-pixels", text: "文字指定像素：1080 × 1920 像素" });
    expect(ownedConversationSizePreview({ ...value, text: "背景改为蓝色，比例3:4，2K" })).toEqual({ source: "dialog-ratio", text: "文字指定比例 / 清晰度：1920 × 2560 像素" });
    expect(ownedConversationSizePreview(draft({ text: "生成一张蓝色海报" }))).toEqual({ source: "control", text: "下拉默认：1024 × 1024 像素" });
  });
  it("does not mistake quoted poster copy for output dimensions or conceal conflicts", () => {
    const value = draft({ references: [ref("a")], quickEditTargetId: "shape:a" });
    expect(ownedConversationSizePreview({ ...value, text: "背景改为蓝色，写上“1920×1080 2K”" })).toMatchObject({ source: "target" });
    expect(ownedConversationSizePreview({ ...value, text: "背景改为蓝色，1080×1920，比例1:1" })).toMatchObject({ source: "clarify", text: expect.stringContaining("不一致") });
    expect(ownedConversationSizePreview({ ...value, text: "背景改为蓝色，4K" })).toMatchObject({ source: "clarify", text: expect.stringContaining("1K 和 2K") });
    expect(ownedConversationSizePreview({ ...value, text: "这样好吗？" })).toMatchObject({ source: "clarify" });
  });
  it("receives the actual advanced output frame without changing its rules or invoking a provider", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const value = draft({ text: "生成一张蓝色海报", references: [ref("a", { purpose: "EXACT" })] });
    expect(ownedConversationSizePreview(value)).toMatchObject({ source: "clarify", text: expect.stringContaining("画框") });
    expect(ownedConversationSizePreview(value, "shape:frame")).toMatchObject({ source: "control" });
    expect(fetcher).not.toHaveBeenCalled(); expect(value.references[0]!.purpose).toBe("EXACT");
  });
});
