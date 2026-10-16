import { describe, expect, it } from "vitest";
import { assignOwnedImageNames, emptyOwnedDocument, ownedImageName, parseOwnedDocument, serializeOwnedDocument, type OwnedCanvasItem } from "../src/lib/owned-canvas-model";
import { duplicateItems } from "../src/lib/owned-canvas-operations";
import { studioOwnedLayerHidden } from "../src/lib/studio-owned-visibility";
const image = (id: string): OwnedCanvasItem => ({ id: `shape:${id}`, kind: "image", url: "/image.png", x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1 });
describe("persistent owned image identities", () => {
  it("upgrades old images once and reopens exact numbers with v3 metadata", () => {
    const doc = assignOwnedImageNames({ ...emptyOwnedDocument(), items: [image("a"), image("b")] });
    const reopened = parseOwnedDocument(serializeOwnedDocument(doc));
    expect(reopened.warnings).toEqual([]); expect(reopened.items.map(ownedImageName)).toEqual(["图片1", "图片2"]);
    expect(reopened.camera).toEqual(doc.camera); expect(assignOwnedImageNames(reopened)).toBe(reopened);
  });
  it("does not recycle numbers after deletion and saving", () => {
    let doc = assignOwnedImageNames({ ...emptyOwnedDocument(), items: [image("a"), image("b")] });
    doc = parseOwnedDocument(serializeOwnedDocument({ ...doc, items: [doc.items[0]!] }));
    doc = assignOwnedImageNames({ ...doc, items: [...doc.items, image("c")] });
    expect(doc.items.map(ownedImageName)).toEqual(["图片1", "图片3"]);
  });
  it("duplicated images get a new number while retaining original provenance", () => {
    const doc = assignOwnedImageNames({ ...emptyOwnedDocument(), items: [image("a")] });
    const copy = duplicateItems(doc.items, [doc.items[0]!.id]);
    const named = assignOwnedImageNames({ ...doc, items: copy.items });
    expect(named.items.map(ownedImageName)).toEqual(["图片1", "图片2"]);
    expect(named.items[1]!.sourceShapeId).toBe("shape:a");
    expect(parseOwnedDocument(serializeOwnedDocument(named)).items[1]!.sourceShapeId).toBe("shape:a");
  });
  it("keeps high water mark when undo restores an earlier source header", () => {
    const old = assignOwnedImageNames({ ...emptyOwnedDocument(), items: [image("a")] });
    const next = assignOwnedImageNames({ ...old, items: [...old.items, image("b")] });
    const undone = assignOwnedImageNames(old, Number((next.source.novartOwnedCanvas as { imageSequence: number }).imageSequence));
    expect(assignOwnedImageNames({ ...undone, items: [...undone.items, image("c")] }).items[1]!.imageNumber).toBe(3);
  });
  it("rejects corrupt identities rather than silently dropping fields", () => {
    const doc = assignOwnedImageNames({ ...emptyOwnedDocument(), items: [image("a")] });
    const source = serializeOwnedDocument(doc);
    const snapshot = source.tldrawSnapshot as { document: { store: Record<string, { meta: { novartOwned: { imageNumber: unknown } } }> } };
    snapshot.document.store["shape:a"]!.meta.novartOwned.imageNumber = "1";
    expect(parseOwnedDocument(source).warnings.length).toBeGreaterThan(0);
    expect(() => serializeOwnedDocument({ ...doc, items: [doc.items[0]!, { ...image("b"), imageNumber: 1 }] })).toThrow(/重复/);
  });
  it("v3 hidden-image metadata remains enforced by backend visibility checks", () => {
    const doc = assignOwnedImageNames({ ...emptyOwnedDocument(), items: [{ ...image("a"), hidden: true }] });
    const source = serializeOwnedDocument(doc), snapshot = source.tldrawSnapshot as { document: { store: Record<string, Record<string, unknown>> } };
    expect(studioOwnedLayerHidden(snapshot.document.store, snapshot.document.store["shape:a"]!)).toBe(true);
  });
  it("unknown future schema is preserved read-only and never renamed", () => {
    const source = emptyOwnedDocument().source; source.novartOwnedCanvas = { version: 999 };
    const doc = parseOwnedDocument(source); expect(doc.warnings.length).toBeGreaterThan(0); expect(assignOwnedImageNames(doc)).toBe(doc);
  });
});
