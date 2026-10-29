const codes = [
  'provider_request_failed', 'provider_http_error', 'provider_response_too_large',
  'provider_response_read_failed', 'provider_response_json_invalid',
  'provider_output_json_invalid', 'provider_content_missing', 'provider_content_filtered',
  'provider_output_truncated', 'provider_schema_invalid', 'provider_citation_invalid',
] as const;
type FailureCode = typeof codes[number];
const allowedCodes = new Set<string>(codes);
const publicMessages: Partial<Record<FailureCode, string>> = {
  provider_output_truncated: '模型回答被截断，请缩小问题范围。',
  provider_citation_invalid: '模型引用了未检索到的证据，回答未保存。',
};

/** Never retain provider text, exception causes, headers, URLs or user content. */
export class InspirationFailure extends Error {
  constructor(public readonly code: FailureCode, public readonly status?: number) {
    super(publicMessages[code] ?? code);
  }
}

export function inspirationFailureDiagnostic(error: unknown, aborted = false): {code: string; status?: number} {
  if (aborted) return {code:'task_aborted'};
  if (!(error instanceof InspirationFailure) || !allowedCodes.has(error.code)) return {code:'task_failed'};
  const status = error.status;
  return {code:error.code, ...(error.code === 'provider_http_error' && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? {status} : {})};
}

/** A bounded provider reader, independent of the publisher/cache transport. */
export async function readInspirationResponse(response: Response): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel().catch(()=>undefined);
    throw new InspirationFailure('provider_http_error',response.status);
  }
  if (!response.body) throw new InspirationFailure('provider_response_read_failed');
  const maximum = 256 * 1024;
  if (Number(response.headers.get('content-length') || 0) > maximum) {
    await response.body.cancel().catch(()=>undefined);
    throw new InspirationFailure('provider_response_too_large');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new InspirationFailure('provider_response_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof InspirationFailure) throw error;
    throw new InspirationFailure('provider_response_read_failed');
  } finally {
    await reader.cancel().catch(()=>undefined);
    reader.releaseLock();
  }
}
