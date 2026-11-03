import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFetchError, apiFetch } from '@/lib/client';

/** The page renders error.message verbatim, so a transport string must never escape. */
const uiText = (error: unknown) => error instanceof ApiFetchError ? error.message : String(error);
afterEach(() => vi.unstubAllGlobals());

describe('apiFetch transport failures stay localized', () => {
  it('wraps a network failure as status 0 with a readable Chinese message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = await apiFetch('/api/isolated').catch(value => value);
    expect(error).toBeInstanceOf(ApiFetchError);
    expect((error as ApiFetchError).status).toBe(0);
    expect(uiText(error)).toBe('网络连接中断，请检查网络后重试。');
    expect(uiText(error)).not.toMatch(/failed to fetch/i);
  });

  it('keeps the server-supplied message and status for an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '案例已撤回、版本已更新或不可访问。' }), { status: 404 })));
    const error = await apiFetch('/api/isolated').catch(value => value);
    expect(error).toBeInstanceOf(ApiFetchError);
    expect((error as ApiFetchError).status).toBe(404);
    expect(uiText(error)).toBe('案例已撤回、版本已更新或不可访问。');
  });

  it('rethrows an abort instead of disguising it as an offline error', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(apiFetch('/api/isolated')).rejects.toBe(abort);
  });
});
