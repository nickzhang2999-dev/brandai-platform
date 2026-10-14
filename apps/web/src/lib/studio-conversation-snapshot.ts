import { gunzipSync, gzipSync } from "node:zlib";
import { EDITOR_DOCUMENT_PREFIX, EDITOR_DOCUMENT_MAX_DECODED_BYTES, type StudioConversationReference } from "@brandai/contracts";
import { ApiException } from "./api";
import { inspectEditorDocument } from "./editor-document-codec";

/** Freeze only referenced shapes, their ancestor graph and an exact output
 * frame. Chat history must not duplicate every stroke in a 32 MiB document. */
export function freezeStudioConversationCanvas(canvas: string, references: StudioConversationReference[], outputFrameId?: string) {
  const requested = [...references.flatMap(ref => ref.shapeId ? [ref.shapeId] : []), ...(outputFrameId ? [outputFrameId] : [])];
  if (!requested.length) return "";
  inspectEditorDocument(canvas);
  const parsed = JSON.parse(gunzipSync(Buffer.from(canvas.slice(EDITOR_DOCUMENT_PREFIX.length), "base64"), { maxOutputLength: EDITOR_DOCUMENT_MAX_DECODED_BYTES }).toString("utf8"));
  const document = parsed.tldrawSnapshot.document;
  const retained: Record<string, unknown> = {};
  for (const id of requested) {
    let current: string | undefined = id; const path = new Set<string>();
    for (let depth = 0; current; depth++) {
      if (depth > 80 || path.has(current)) throw new ApiException(422, "引用图片的容器关系无效，请重新保存画布。");
      path.add(current);
      const shape: Record<string, unknown> | undefined = document.store[current];
      if (!shape || shape.id !== current) throw new ApiException(422, "引用图片所在的画布记录已失效。");
      retained[current] = shape;
      current = typeof shape.parentId === "string" ? shape.parentId : undefined;
    }
  }
  const raw = JSON.stringify({ tldrawSnapshot: { document: { schema: document.schema, store: retained } } });
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new ApiException(422, "本次引用快照过大，请整理图片内容后再发送。");
  const compressed = gzipSync(raw);
  if (compressed.length > 1024 * 1024) throw new ApiException(422, "本次引用快照过大，请减少参与图片后再发送。");
  return EDITOR_DOCUMENT_PREFIX + compressed.toString("base64");
}
