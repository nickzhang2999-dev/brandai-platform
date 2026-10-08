import { ApiException } from "./api";

/** Bound the stream before buffering it, including requests without Content-Length. */
export async function readWorkbenchJson(req: Request, maxBytes: number): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiException(415, "Expected application/json");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new ApiException(400, "Missing request body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiException(413, "Request too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ApiException(400, "Invalid JSON"); }
}
