import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { LibraryRecipient, validatePublicationBinding } from './publication-scope';
import { syncSizeLimits } from './config';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
// Never transform signed values before verifying their canonical bytes.
const text = z.string().min(1).max(50000).refine(v=>!!v.trim());
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const path = z.string().max(512).refine(p => p === 'records.jsonl' || (p.startsWith('images/') && !p.includes('\\') && p.split('/').every(s => s && s !== '.' && s !== '..' && !s.includes('%') && !s.includes('\0'))));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({ source_id: id, url: z.string().url().refine(s => { const u = new URL(s); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password; }), display_permission: z.literal('allowed') }).passthrough();
const image = z.object({ image_id: id, path: path.refine(p => p.startsWith('images/')), source_id: id, display_permission: z.literal('allowed') }).passthrough();
const claim = z.object({ claim_id: id, kind: z.enum(['author_statement','media_statement','visual_observation','analysis_inference']), text, source_ids: z.array(id).max(500), image_ids: z.array(id).max(500) }).passthrough();
export const PublishedCase = z.object({ case_id: id, revision: positive, title: text, summary_zh: text.refine(v => /[\u3400-\u9fff]/u.test(v)), brand_or_team: text, review_status: z.literal('approved'), display_permission: z.literal('allowed'), analysis_version: text, model_version: text,
  tags: z.object({ industry: z.array(text).min(1).max(100), medium: z.array(text).min(1).max(100) }).catchall(z.array(text).max(100)), sources: z.array(source).min(1).max(500), images: z.array(image).min(1).max(500), claims: z.array(claim).min(1).max(500),
}).passthrough();
export type PublishedCase = z.infer<typeof PublishedCase>;
const manifestFields={release_id: id, sequence: positive, kind: z.enum(['full','delta']), parent_release_id: id.nullable(), created_at: z.string().datetime(), taxonomy_version: text, records_count: z.number().int().min(0).max(2000), files: z.array(z.object({ path, size: z.number().int().nonnegative().max(128*1024*1024), sha256: hash }).strict()).max(10000), key_id: id, signature: z.string().max(256)};
export const Manifest = z.discriminatedUnion('schema_version',[
  z.object({schema_version:z.literal(1),...manifestFields}).strict(),
  z.object({schema_version:z.literal(2),recipient:LibraryRecipient,...manifestFields}).strict(),
]);
export type Manifest = z.infer<typeof Manifest>;
export function checkedPackageSize(manifest: Manifest): number {
  const bytes = manifest.files.reduce((total, file) => total + file.size, 0);
  if (bytes > syncSizeLimits().packageBytes) throw new Error('Knowledge package exceeds configured size limit');
  return bytes;
}
const withdrawalFields={sequence: positive, created_at: z.string().datetime(), case_ids: z.array(id).max(100000), key_id: id, signature: z.string().max(256)};
export const Withdrawal = z.discriminatedUnion('schema_version',[
  z.object({schema_version:z.literal(1),...withdrawalFields}).strict(),
  z.object({schema_version:z.literal(2),recipient:LibraryRecipient,...withdrawalFields}).strict(),
]);
const RecordSchema = z.object({ op: z.enum(['upsert','delete']), case_id: id, revision: positive, content_hash: hash, case: PublishedCase.optional() }).strict();
export type ReleaseRecord = z.infer<typeof RecordSchema>;
export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value) return `{${Object.keys(value).sort(unicodeOrder).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  throw new Error('Unsupported canonical value');
}
function unicodeOrder(a:string,b:string) { const x=Array.from(a,c=>c.codePointAt(0)!),y=Array.from(b,c=>c.codePointAt(0)!);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]!-y[i]!;return x.length-y.length; }
export function verifySigned<T extends { key_id: string; signature: string }>(value: T, keys: Record<string,string>): T {
  const pem = keys[value.key_id]; if (!pem) throw new Error('Unknown signing key');
  const publicKey = createPublicKey(pem); if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519');
  const { signature, ...payload } = value;
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, Buffer.from(canonical(payload)), publicKey, Buffer.from(signature,'base64'))) throw new Error('Invalid signature');
  return value;
}
function unique(values: string[]) { if (new Set(values).size !== values.length) throw new Error('Duplicate identity'); }
export function validateCase(c: PublishedCase) {
  validatePublicationBinding(c);
  unique(c.sources.map(s => s.source_id)); unique(c.images.map(i => i.image_id)); unique(c.claims.map(c => c.claim_id));
  const sources = new Set(c.sources.map(s => s.source_id)), images = new Set(c.images.map(i => i.image_id));
  if (c.images.some(i => !sources.has(i.source_id)) || c.claims.some(c => (!c.source_ids.length && !c.image_ids.length) || c.source_ids.some(s => !sources.has(s)) || c.image_ids.some(i => !images.has(i)))) throw new Error('Broken evidence reference');
}
/** Authenticate records and their declared image inventory before fetching image bytes. */
export function validatePackageMetadata(raw:Buffer,recordBytes:Buffer,keys:Record<string,string>) {
  const manifest = verifySigned(Manifest.parse(JSON.parse(raw.toString('utf8'))), keys);
  if ((manifest.kind === 'full') !== (manifest.parent_release_id === null)) throw new Error('Invalid release parent');
  unique(manifest.files.map(f => f.path));
  checkedPackageSize(manifest);
  const entry=manifest.files.find(f=>f.path==='records.jsonl');
  if(!entry)throw new Error('Incomplete package');
  if(recordBytes.length!==entry.size||sha256(recordBytes)!==entry.sha256)throw new Error('File checksum mismatch');
  const inventory=new Map(manifest.files.map(f=>[f.path,f]));
  if(manifest.files.some(f=>f.path.startsWith('images/')&&(f.size<=0||f.size>20*1024*1024)))throw new Error('Image too large');
  const lines = recordBytes.toString('utf8').split('\n').filter(s => s.trim());
  if (lines.length !== manifest.records_count || lines.some(s => Buffer.byteLength(s) > 1024*1024)) throw new Error('Invalid record count or size');
  const records = lines.map(line => RecordSchema.parse(JSON.parse(line))); unique(records.map(r => r.case_id));
  const used = new Set(['records.jsonl']);
  for (const r of records) {
    if (r.op === 'upsert') {
      if (!r.case || r.case.case_id !== r.case_id || r.case.revision !== r.revision || sha256(canonical(r.case)) !== r.content_hash) throw new Error('Invalid case record');
      validateCase(r.case); for (const i of r.case.images) { if (!inventory.has(i.path)) throw new Error('Missing image'); used.add(i.path); }
      const basis=validatePublicationBinding(r.case);
      if(basis&&inventory.get(r.case.images[0]!.path)?.sha256!==basis.sha256)throw new Error('Publication image checksum mismatch');
    } else if (r.case || sha256(canonical({op:r.op,case_id:r.case_id,revision:r.revision})) !== r.content_hash) throw new Error('Invalid delete record');
  }
  if (used.size !== inventory.size) throw new Error('Unreferenced package file');
  return {manifest,records};
}
export async function validatePackage(raw: Buffer, files: Map<string,Buffer>, keys: Record<string,string>) {
  // Preserve the early size/inventory gate even for an absent records file.
  const envelope=verifySigned(Manifest.parse(JSON.parse(raw.toString('utf8'))),keys);checkedPackageSize(envelope);
  if(!files.has('records.jsonl')||files.size!==envelope.files.length)throw new Error('Incomplete package');
  const {manifest,records}=validatePackageMetadata(raw,files.get('records.jsonl')!,keys);
  const mimes=new Map<string,string>();
  for(const f of manifest.files) {
    const data=files.get(f.path);if(!data||data.length!==f.size||sha256(data)!==f.sha256)throw new Error('File checksum mismatch');
    if(f.path.startsWith('images/')) {
      const processor=sharp(data,{limitInputPixels:40000000,failOn:'error'}),meta=await processor.metadata();
      if(!meta.format||!['jpeg','png','webp'].includes(meta.format)||(meta.pages??1)>1)throw new Error('Unsupported image');
      await processor.stats();mimes.set(f.path,meta.format==='jpeg'?'image/jpeg':`image/${meta.format}`);
    }
  }
  return { manifest, records, mimes };
}
