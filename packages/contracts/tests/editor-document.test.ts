import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EditorDocumentSaveInput, EditorDocumentView } from "../src/editor-document";
import { inspectEditorDocument, documentWriteDecision, assertDocumentReferences } from "../../../apps/web/src/lib/editor-document-codec";

const encode = (value: unknown) => "SHAKKERDATA://" + gzipSync(JSON.stringify(value)).toString("base64");
const snapshot = { tldrawSnapshot: { document: { schema: { schemaVersion: 2 }, store: {
  "shape:pen": { id: "shape:pen", typeName: "shape", type: "draw", rotation: 0.4,
    props: { segments: [{ points: [{ x: 1, y: 2, z: 0.7 }, { x: 3, y: 5, z: 0.9 }] }] } },
  "shape:text": { id: "shape:text", typeName: "shape", type: "text", props: { text: "中文\n第二行", fontSize: 37 } },
} }, session: { camera: { x: 100, y: -50, z: 0.7 } } }, extension: { futureField: [1, 2, 3] } };
const mutationId = "ad2cb954-07f8-47af-a19f-dfc253364604";
const input = { format: "novart-native-v1", canvas: encode(snapshot), revision: 0, mutationId };

describe("full native editor persistence boundary", () => {
  it("accepts a substantial compressed native document without regexp stack overflow", () => {
    const canvas = encode({ ...snapshot, extension: randomBytes(512 * 1024).toString("base64") });
    expect(canvas.length).toBeGreaterThan(500_000);
    expect(inspectEditorDocument(canvas).checksum).toMatch(/^[a-f0-9]{64}$/);
  });
  it("preserves the exact encoded document including pen pressure, rotation, Chinese text and future fields", () => {
    const parsed = EditorDocumentSaveInput.parse(input);
    expect(parsed.canvas).toBe(input.canvas);
    expect(inspectEditorDocument(parsed.canvas).checksum).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects malformed or non-native documents before persistence", () => {
    for (const canvas of ["{}", "SHAKKERDATA://bad!", encode({ items: [] }), encode({ tldrawSnapshot: { document: { store: [], schema: {} } } })]) {
      expect(() => inspectEditorDocument(canvas)).toThrow();
    }
  });
  it("bounds expansion of a small compressed payload", () => {
    expect(() => inspectEditorDocument(encode({ ...snapshot, padding: "a".repeat(33 * 1024 * 1024) }))).toThrow();
  });
  it("rejects values that parse into non-finite numbers", () => {
    const canvas = "SHAKKERDATA://" + gzipSync('{"tldrawSnapshot":{"document":{"schema":{},"store":{}}},"x":1e999}').toString("base64");
    expect(() => inspectEditorDocument(canvas)).toThrow();
  });
  it("rejects transient images but permits matching text content", () => {
    expect(() => inspectEditorDocument(encode({ ...snapshot, image: { url: "blob:temporary" } }))).toThrow();
    expect(() => inspectEditorDocument(encode({ ...snapshot, text: "data:image/png;base64,this is text" }))).not.toThrow();
  });
  it("does not authorize a cross-workspace URL by its asset id or basename", () => {
    const own = "/api/workspaces/own/assets/a1/raw";
    expect(() => assertDocumentReferences([own], new Set([own]))).not.toThrow();
    expect(() => assertDocumentReferences(["/api/workspaces/other/assets/a1/raw"], new Set([own]))).toThrow();
    expect(() => assertDocumentReferences(["https://foreign.test/a1/raw"], new Set([own]))).toThrow();
  });
  it("only permits initial creation at revision zero", () => {
    expect(documentWriteDecision(null, { revision: 0, mutationId }, "hash", "owner")).toBe("write");
    expect(() => documentWriteDecision(null, { revision: 5, mutationId }, "hash", "owner")).toThrow();
  });
  it("a lost save response can be retried without creating a new revision", () => {
    const current = { revision: 1, mutationId, checksum: "hash", updatedById: "owner" };
    expect(documentWriteDecision(current, { revision: 0, mutationId }, "hash", "owner")).toBe("replay");
    expect(() => documentWriteDecision(current, { revision: 0, mutationId }, "changed", "owner")).toThrow();
    expect(() => documentWriteDecision(current, { revision: 0, mutationId }, "hash", "other")).toThrow();
  });
  it("stale tabs cannot overwrite newer saves even when payloads match", () => {
    const current = { revision: 3, mutationId: "other", checksum: "hash", updatedById: "owner" };
    expect(() => documentWriteDecision(current, { revision: 1, mutationId }, "hash", "owner")).toThrow();
    expect(documentWriteDecision(current, { revision: 3, mutationId }, "new", "owner")).toBe("write");
  });
  it("rejects unsupported formats and unknown wire fields", () => {
    expect(EditorDocumentSaveInput.safeParse({ ...input, format: "future" }).success).toBe(false);
    expect(EditorDocumentSaveInput.safeParse({ ...input, workspaceId: "injected" }).success).toBe(false);
    expect(EditorDocumentSaveInput.safeParse({ ...input, revision: true }).success).toBe(false);
  });
  it("models an unsaved document explicitly rather than as a successful saved revision", () => {
    expect(EditorDocumentView.parse({ projectId: "p", workspaceId: "w", format: "novart-native-v1", canvas: "", revision: 0, checksum: null, updatedAt: null, readOnly: false }).revision).toBe(0);
  });
});
