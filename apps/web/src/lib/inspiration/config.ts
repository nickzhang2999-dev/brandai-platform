export const inspirationEnabled = () => process.env.INSPIRATION_ENABLED === 'true';
// Defaults retain the trial profile. Operator overrides stay within A's signed
// 512 MiB package contract; an invalid override fails closed before downloads.
export function syncSizeLimits() {
  const mib = (name: string, fallback: number) => {
    const value = process.env[name]?.trim();
    if (!value) return fallback;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > 512) throw new Error('Invalid inspiration size limits');
    return Number(value);
  };
  const packageMiB = mib('INSPIRATION_MAX_PACKAGE_MIB', 128);
  const syncMiB = mib('INSPIRATION_MAX_SYNC_MIB', 256);
  if (packageMiB > syncMiB) throw new Error('Invalid inspiration size limits');
  return {packageBytes: packageMiB * 1024 * 1024, syncBytes: syncMiB * 1024 * 1024};
}
// Omission retains existing installations; an unknown explicit value never
// silently enables unattended content imports.
export function contentSyncMode(): 'manual' | 'automatic' {
  const value = process.env.INSPIRATION_CONTENT_SYNC_MODE?.trim();
  return !value || value === 'automatic' ? 'automatic' : 'manual';
}
export function receiverOrigin(): string | null {
  const value = process.env.INSPIRATION_RECEIVER_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? value : null;
  } catch { return null; }
}
export function syncConfig() {
  const value = process.env.INSPIRATION_PUBLISHER_URL?.trim();
  const token = process.env.INSPIRATION_READ_TOKEN?.trim();
  const keys = JSON.parse(process.env.INSPIRATION_TRUSTED_KEYS_JSON || '{}') as Record<string,string>;
  if (!value || !token || !Object.keys(keys).length) return null;
  const url = new URL(value);
  // Only explicit operator configuration; HTTP is restricted to a local SSH forward.
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Invalid publisher configuration');
  return { baseUrl:url.toString().replace(/\/+$/,''), token, keys };
}
export function syncConfigured() { try { return !!syncConfig(); } catch { return false; } }
export async function boundedBody(response: Response, max: number): Promise<Buffer> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Upstream unavailable (${response.status})`); }
  const declared = Number(response.headers.get('content-length') || '0'); if (declared > max) { await response.body.cancel(); throw new Error('Upstream body too large'); }
  const reader=response.body.getReader(), chunks: Uint8Array[]=[]; let size=0;
  try { while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>max) throw new Error('Upstream body too large'); chunks.push(value); } return Buffer.concat(chunks); }
  finally { await reader.cancel().catch(()=>undefined); reader.releaseLock(); }
}
