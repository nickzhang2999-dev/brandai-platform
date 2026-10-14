import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { freezeStudioConversationCanvas } from "../../../apps/web/src/lib/studio-conversation-snapshot";
const ref: any = { shapeId: "shape:image" };
const encode = (store: unknown) => "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store } } })).toString("base64");
const decode = (canvas: string) => JSON.parse(gunzipSync(Buffer.from(canvas.slice("SHAKKERDATA://".length), "base64")).toString()).tldrawSnapshot.document.store;
describe("bounded immutable conversation source snapshot", () => {
  it("retains image and ancestors without copying unrelated text or strokes", () => {
    const canvas = encode({ "page:main": { id: "page:main", typeName: "page" }, "shape:group": { id: "shape:group", parentId: "page:main" },
      "shape:image": { id: "shape:image", parentId: "shape:group", props: { url: "/api/workspaces/w/assets/a/raw" } }, "shape:other": { id: "shape:other", text: "private unrelated text" } });
    const result = decode(freezeStudioConversationCanvas(canvas, [ref]));
    expect(Object.keys(result).sort()).toEqual(["page:main", "shape:group", "shape:image"]);
    expect(result["shape:image"].props.url).toBe("/api/workspaces/w/assets/a/raw");
  });
  it("needs no native snapshot for sourceless generation or brand-only references", () => {
    expect(freezeStudioConversationCanvas("", [])).toBe(""); expect(freezeStudioConversationCanvas("", [{ referenceId: "asset:a" } as any])).toBe("");
  });
  it("retains the output frame and rejects cycles or missing ancestors", () => {
    const canvas = encode({ "shape:frame": { id: "shape:frame" } }); expect(Object.keys(decode(freezeStudioConversationCanvas(canvas, [], "shape:frame")))).toEqual(["shape:frame"]);
    for (const store of [{ "shape:image": { id: "shape:image", parentId: "shape:image" } }, { "shape:image": { id: "shape:image", parentId: "missing" } }]) expect(() => freezeStudioConversationCanvas(encode(store), [ref])).toThrow();
  });
});
