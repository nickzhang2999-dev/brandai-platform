/** Worker-only semantic adapter. GET handlers must read persisted vectors, never call embedTexts.
 * Explicit server environment (no browser/user endpoint override):
 * INSPIRATION_EMBEDDING_ENDPOINT=https://provider.example/v1/embeddings
 * INSPIRATION_EMBEDDING_MODEL=<operator-confirmed model>
 * INSPIRATION_EMBEDDING_DIMENSIONS=<operator-confirmed dimensions>
 * INSPIRATION_EMBEDDING_VERSION=1 (bump when model/preprocessing changes)
 * INSPIRATION_EMBEDDING_API_KEY=<server secret>; optional TIMEOUT_MS=15000
 * No COPYWRITING/VLM credentials are inferred. Trial vectors may be stored as DB JSON.
 */
import { createHash } from 'node:crypto';
import { assertSafePublicUrl } from '@/lib/ssrf';
import { boundedBody } from './config';

export type EmbeddingConfig = { endpoint: string; apiKey: string; model: string; dimensions: number; version: string; timeoutMs: number };
export type CachedEmbedding = { space: string; dimensions: number; vector: number[] };
export type EmbeddingResult = { ok: true; space: string; vectors: number[][] } | { ok: false; reason: 'not-configured'|'invalid-input'|'cancelled'|'timeout'|'provider-unavailable' };
export type EmbeddingCache = { get(key: string): Promise<unknown>; put(key: string, value: CachedEmbedding): Promise<void> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function embeddingConfig(env: Record<string,string|undefined> = process.env): EmbeddingConfig | null {
  const endpoint = env.INSPIRATION_EMBEDDING_ENDPOINT?.trim() || '';
  const model = env.INSPIRATION_EMBEDDING_MODEL?.trim() || '';
  const apiKey = env.INSPIRATION_EMBEDDING_API_KEY?.trim() || '';
  const dimensions = Number(env.INSPIRATION_EMBEDDING_DIMENSIONS);
  const version = env.INSPIRATION_EMBEDDING_VERSION?.trim() || '1';
  const timeoutMs = Number(env.INSPIRATION_EMBEDDING_TIMEOUT_MS || '15000');
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        (url.port && url.port !== '443') || !model || model.length > 200 || !apiKey ||
        !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || !version || version.length > 100) return null;
    return { endpoint: url.toString(), apiKey, model, dimensions, version, timeoutMs };
  } catch { return null; }
}
export function embeddingSpace(config: EmbeddingConfig): string {
  return hash(JSON.stringify([config.endpoint, config.model, config.dimensions, config.version]));
}
export function embeddingCacheKey(scope: string, config: EmbeddingConfig, text: string): string {
  return hash(JSON.stringify([scope, embeddingSpace(config), text]));
}
export function validVector(value: unknown, dimensions: number): value is number[] {
  return Number.isInteger(dimensions) && dimensions > 0 && dimensions <= 4096 && Array.isArray(value) &&
    value.length === dimensions && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e10) &&
    value.some(n => n !== 0);
}
function cached(value: unknown, space: string, dimensions: number): value is CachedEmbedding {
  if (!value || typeof value !== 'object') return false;
  const v = value as CachedEmbedding;
  return v.space === space && v.dimensions === dimensions && validVector(v.vector, dimensions);
}

/** One bounded batch; no retry that could duplicate paid requests. Cache scoped by workspace and full embedding space. */
export async function embedTexts(config: EmbeddingConfig | null, texts: string[], signal?: AbortSignal,
  cacheOptions?: { scope: string; cache: EmbeddingCache }): Promise<EmbeddingResult> {
  if (!config || !embeddingConfig({ INSPIRATION_EMBEDDING_ENDPOINT: config.endpoint, INSPIRATION_EMBEDDING_API_KEY: config.apiKey,
    INSPIRATION_EMBEDDING_MODEL: config.model, INSPIRATION_EMBEDDING_DIMENSIONS: String(config.dimensions),
    INSPIRATION_EMBEDDING_VERSION: config.version, INSPIRATION_EMBEDDING_TIMEOUT_MS: String(config.timeoutMs) })) return { ok: false, reason: 'not-configured' };
  if (!texts.length || texts.length > 16 || texts.some(t => typeof t !== 'string' || !t.trim() || t.length > 16000) ||
      texts.reduce((n,t) => n + t.length, 0) > 64000 || (cacheOptions && !cacheOptions.scope)) return { ok: false, reason: 'invalid-input' };
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  const space = embeddingSpace(config), controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  });
  const operation = async (): Promise<EmbeddingResult> => {
    const vectors: number[][] = new Array(texts.length), missing: number[] = [];
    for (let i=0; i<texts.length; i++) {
      let value: unknown;
      try { value = await cacheOptions?.cache.get(embeddingCacheKey(cacheOptions.scope, config, texts[i]!)); } catch { /* cache miss */ }
      if (controller.signal.aborted) throw new Error('aborted');
      if (cached(value, space, config.dimensions)) vectors[i] = value.vector;
      else missing.push(i);
    }
    if (missing.length) {
      await assertSafePublicUrl(config.endpoint);
      if (controller.signal.aborted) throw new Error('aborted');
      const response = await fetch(config.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, dimensions: config.dimensions, input: missing.map(i => texts[i]), encoding_format: 'float' }) });
      const raw = JSON.parse((await boundedBody(response, 2 * 1024 * 1024)).toString('utf8')) as { model?: unknown; data?: unknown };
      if (raw.model !== config.model || !Array.isArray(raw.data) || raw.data.length !== missing.length) throw new Error('invalid embedding response');
      const seen = new Set<number>();
      for (const entry of raw.data as { index: number; embedding: unknown }[]) {
        if (!entry || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= missing.length || seen.has(entry.index) ||
            !validVector(entry.embedding, config.dimensions)) throw new Error('invalid embedding vector');
        seen.add(entry.index); vectors[missing[entry.index]!] = entry.embedding;
      }
      if (controller.signal.aborted) throw new Error('aborted');
      for (const i of missing) {
        if (controller.signal.aborted) throw new Error('aborted');
        try { await cacheOptions?.cache.put(embeddingCacheKey(cacheOptions.scope, config, texts[i]!), { space, dimensions: config.dimensions, vector: vectors[i]! }); } catch { /* cache failure must not invalidate a valid result */ }
      }
    }
    return { ok: true, space, vectors };
  };
  try { return await Promise.race([operation(), aborted]); }
  catch { return { ok: false, reason: timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'provider-unavailable' }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (!validVector(a, a.length) || !validVector(b, a.length)) return null;
  let dot=0, aa=0, bb=0;
  for (let i=0;i<a.length;i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  const score = dot / Math.sqrt(aa * bb);
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : null;
}
/** Caller must resolve current workspace ACL, display rights and withdrawals before setting allowed=true. */
export function rankEmbeddings(query: CachedEmbedding, candidates: { caseId: string; allowed: boolean; embedding?: CachedEmbedding }[]): { caseId: string; score: number }[] {
  if (!cached(query, query.space, query.dimensions)) return [];
  return candidates.flatMap(c => {
    if (c.allowed !== true || !cached(c.embedding, query.space, query.dimensions)) return [];
    const score=cosineSimilarity(query.vector,c.embedding.vector);
    return score === null ? [] : [{ caseId:c.caseId, score }];
  }).sort((a,b) => b.score-a.score || a.caseId.localeCompare(b.caseId));
}
export function rankHybrid<T extends {caseId:string;allowed:boolean;keywordScore:number;embedding?:CachedEmbedding}>(candidates:T[],query:CachedEmbedding|null,limit=20):{searchMode:'hybrid'|'keyword-tags';cases:T[]} {
  const permitted=candidates.filter(c=>c.allowed===true);
  const keyword=[...permitted].sort((a,b)=>(Number.isFinite(b.keywordScore)?b.keywordScore:0)-(Number.isFinite(a.keywordScore)?a.keywordScore:0)||a.caseId.localeCompare(b.caseId));
  const semantic=query ? rankEmbeddings(query,permitted) : [];
  const scores=new Map<string,number>();
  if(semantic.length) {
    keyword.filter(c=>c.keywordScore>0).forEach((c,i)=>scores.set(c.caseId,1/(60+i+1)));
    semantic.forEach((c,i)=>scores.set(c.caseId,(scores.get(c.caseId)||0)+1/(60+i+1)));
  }
  const ranked=semantic.length ? [...permitted].sort((a,b)=>(scores.get(b.caseId)||0)-(scores.get(a.caseId)||0)||a.caseId.localeCompare(b.caseId)) : keyword;
  return {searchMode:semantic.length?'hybrid':'keyword-tags',cases:ranked.slice(0,Math.max(0,Math.min(200,Math.floor(limit))))};
}
