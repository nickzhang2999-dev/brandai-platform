/** Product generation transport limits share the worker's authoritative deadline. */
export interface AiCallOptions {
  signal?: AbortSignal;
  maxResponseBytes?: number;
  /** Server-only product boundary; never accepted from browser job payloads. */
  requireRealImageProvider?: boolean;
}

/** Does not cancel non-cancellable DB work, but forbids subsequent network I/O. */
export function withinAiDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", aborted);
    // Always observe the promise, including when the deadline expired before
    // this function was called: already-started DB work may still reject.
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function readBoundedAiJson<T>(response: Response, signal: AbortSignal, maxBytes: number): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid AI response limit");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("图片服务返回内容超过限制，请联系管理员检查服务。");
  }
  if (!response.body) throw new Error("图片服务返回空响应。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await withinAiDeadline(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("图片服务返回内容超过限制，请联系管理员检查服务。");
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as T; }
    catch { throw new Error("图片服务返回格式无法识别，请联系管理员检查服务。"); }
  } finally {
    // Cancel even when the upstream stream ignores AbortSignal. Do not await
    // a broken source's cancel promise after the request deadline has passed.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
