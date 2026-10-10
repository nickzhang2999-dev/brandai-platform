import { EDITOR_DOCUMENT_MAX_BYTES, EDITOR_DOCUMENT_MAX_DECODED_BYTES, EDITOR_DOCUMENT_PREFIX } from "@brandai/contracts";
import { emptyOwnedDocument, parseOwnedDocument, serializeOwnedDocument, type OwnedCanvasDocument } from "./owned-canvas-model";

async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > max) { await reader.cancel(); throw new Error("画布文件超过安全大小限制。"); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

export async function decodeOwnedCanvas(canvas: string): Promise<OwnedCanvasDocument> {
  if (canvas === "") return emptyOwnedDocument();
  if (typeof canvas !== "string" || canvas.length > EDITOR_DOCUMENT_MAX_BYTES || !canvas.startsWith(EDITOR_DOCUMENT_PREFIX)) throw new Error("画布文件格式无效，原内容已保留。");
  const encoded = canvas.slice(EDITOR_DOCUMENT_PREFIX.length);
  if (!encoded || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error("画布压缩数据无效。");
  try {
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) throw new Error("Invalid base64");
    const compressed = Uint8Array.from(binary, character => character.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const bytes = await readBounded(stream, EDITOR_DOCUMENT_MAX_DECODED_BYTES);
    return parseOwnedDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new Error("画布文件无法安全读取，原内容已保留，请勿覆盖。"); }
}

export async function encodeOwnedCanvas(doc: OwnedCanvasDocument): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(serializeOwnedDocument(doc)));
  if (bytes.length > EDITOR_DOCUMENT_MAX_DECODED_BYTES) throw new Error("画布内容超过保存上限。");
  const compressed = await readBounded(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), EDITOR_DOCUMENT_MAX_BYTES);
  let binary = "";
  for (let offset = 0; offset < compressed.length; offset += 32768) binary += String.fromCharCode(...compressed.subarray(offset, offset + 32768));
  const canvas = EDITOR_DOCUMENT_PREFIX + btoa(binary);
  if (canvas.length > EDITOR_DOCUMENT_MAX_BYTES) throw new Error("画布压缩文件超过保存上限。");
  return canvas;
}
