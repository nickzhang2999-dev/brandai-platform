import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  EDITOR_DOCUMENT_PREFIX,
  EDITOR_DOCUMENT_MAX_BYTES,
  EDITOR_DOCUMENT_MAX_DECODED_BYTES,
} from "@brandai/contracts";

export class EditorDocumentError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const mediaKeys = new Set([
  "url", "src", "imageUrl", "originalUrl", "thumbnail", "thumbnailUrl",
  "videoUrl", "audioUrl", "fileUrl",
]);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Decode to inspect, store the original string to preserve every native field. */
export function inspectEditorDocument(canvas: string) {
  const invalid = () => new EditorDocumentError(422, "INVALID_DOCUMENT", "画布文档无法读取，请保留当前内容后重试。");
  if (!canvas.startsWith(EDITOR_DOCUMENT_PREFIX) || Buffer.byteLength(canvas) > EDITOR_DOCUMENT_MAX_BYTES) throw invalid();
  const encoded = canvas.slice(EDITOR_DOCUMENT_PREFIX.length);
  // Avoid repeating a grouped expression over megabytes (V8's regexp stack is bounded).
  if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) throw invalid();
  const compressed = Buffer.from(encoded, "base64");
  if (compressed.toString("base64") !== encoded) throw invalid();
  let document: unknown;
  try {
    const raw = gunzipSync(compressed, { maxOutputLength: EDITOR_DOCUMENT_MAX_DECODED_BYTES });
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch { throw invalid(); }
  if (!object(document) || !object(document.tldrawSnapshot) || !object(document.tldrawSnapshot.document)) throw invalid();
  const snapshot = document.tldrawSnapshot.document;
  if (!object(snapshot.store) || !object(snapshot.schema)) throw invalid();
  const urls = new Set<string>();
  const stack: Array<{ value: unknown; depth: number; key: string }> = [{ value: document, depth: 0, key: "" }];
  let count = 0;
  while (stack.length) {
    const { value, depth, key } = stack.pop()!;
    if (++count > 500_000 || depth > 80) throw invalid();
    if (typeof value === "number" && !Number.isFinite(value)) throw invalid();
    if (typeof value === "string" && mediaKeys.has(key) && value) {
      // No transient bytes/URLs or arbitrary remote images in durable documents.
      // Text content is unaffected; only resource-valued fields are inspected.
      if (value.startsWith("data:") || value.startsWith("blob:") || value.length > 4096) {
        throw new EditorDocumentError(422, "UNSAVED_ASSET", "图片尚未保存到素材库，请等待上传完成后重试。");
      }
      urls.add(value);
    }
    if (Array.isArray(value)) for (const item of value) stack.push({ value: item, depth: depth + 1, key });
    else if (object(value)) for (const [childKey, item] of Object.entries(value)) stack.push({ value: item, depth: depth + 1, key: childKey });
  }
  if (urls.size > 2000) throw invalid();
  return { checksum: createHash("sha256").update(canvas).digest("hex"), urls: [...urls] };
}

export function assertDocumentReferences(urls: string[], allowed: Set<string>) {
  if (urls.some(url => !allowed.has(url))) {
    throw new EditorDocumentError(422, "INVALID_ASSET_REFERENCE", "画布含有尚未入库或不属于当前品牌、项目的素材。请重新上传或选择素材。");
  }
}

export function documentWriteDecision(current: {
  revision: number; mutationId: string; checksum: string; updatedById: string;
} | null, input: { revision: number; mutationId: string }, checksum: string, userId: string) {
  if (current?.mutationId === input.mutationId) {
    if (current.checksum === checksum && current.updatedById === userId && current.revision === input.revision + 1) return "replay";
    throw new EditorDocumentError(409, "MUTATION_CONFLICT", "这次保存请求已被用于其他内容，请重新读取后再保存。");
  }
  if ((current?.revision ?? 0) !== input.revision) {
    throw new EditorDocumentError(409, "DOCUMENT_CONFLICT", "画布已在其他页面更新。当前修改仍保留，请重新读取后再处理冲突。");
  }
  return "write";
}
