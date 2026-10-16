import { describe, expect, it } from "vitest";
import { emptyOwnedDocument, assignOwnedImageNames } from "../src/lib/owned-canvas-model";
import { mergeOwnedConversationReferences, ownedConversationDraftEqual, selectedOwnedConversationReferences } from "../src/components/owned-canvas/owned-conversation-references";
const receipt = (id: string) => ({ assetId: id, assetSha256: id.repeat(64), width: 1200, height: 900, url: `/api/workspaces/w/assets/${id}/raw`, versionId: `v${id}` });
const reference = (id: string) => ({ referenceId: `shape:${id}`, shapeId: `shape:${id}`, name: `图片${id}`, assetId: id, assetSha256: id.repeat(64), width: 1200, height: 900, purpose: "REFERENCE" as const });
describe("explicit ordered conversation references", () => {
  it("treats API-normalized object field order as equal but preserves array order", () => {
    const a = { text: "修改", references: [reference("a"), reference("b")] };
    const b = { references: [{ ...reference("a"), name: "图片a" }, reference("b")], text: "修改" };
    expect(ownedConversationDraftEqual(a, b)).toBe(true);
    expect(ownedConversationDraftEqual(a, { ...b, references: [...b.references].reverse() })).toBe(false);
    expect(ownedConversationDraftEqual(a, { ...b, text: "另一份需求" })).toBe(false);
  });
  it("adding references is ordered, deduplicated and leaves the original frozen message unchanged", () => {
    const frozen = [reference("a")], merged = mergeOwnedConversationReferences(frozen, [reference("b"), reference("a")]);
    merged[0]!.name = "new"; expect(frozen[0]!.name).toBe("图片a"); expect(merged.map(value => value.assetId)).toEqual(["a", "b"]);
  });
  it("rejects overflow atomically without dropping prior references", () => {
    const old = "abcdefgh".split("").map(reference);
    expect(() => mergeOwnedConversationReferences(old, [reference("i")])).toThrow(/8/); expect(old.length).toBe(8);
  });
  it("uses image identities with natural receipt pixels rather than canvas display size", () => {
    const doc = assignOwnedImageNames({ ...emptyOwnedDocument(), items: [{ id: "shape:a", kind: "image" as const, x: 0, y: 0, w: 300, h: 225, rotation: 0, opacity: 1, url: receipt("a").url, assetId: "a", assetSha256: "a".repeat(64), versionId: "va" }] });
    expect(selectedOwnedConversationReferences(doc, ["shape:a"], [receipt("a")])).toEqual([{ ...reference("a"), name: "图片1", versionId: "va" }]);
    expect(() => selectedOwnedConversationReferences(doc, ["shape:a"], [{ ...receipt("a"), versionId: "other" }])).toThrow(/持久化/);
    expect(() => selectedOwnedConversationReferences({ ...doc, items: [{ ...doc.items[0]!, hidden: true }] }, ["shape:a"], [receipt("a")])).toThrow(/隐藏/);
  });
});
