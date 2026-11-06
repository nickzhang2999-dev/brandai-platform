import { z } from 'zod';

/** Additive v3 wire contract. These limits do not alter v1/v2 or enable reception. */
export const INSPIRATION_SNAPSHOT_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  partBytes: 8 * 1024 * 1024,
  recordBytes: 1024 * 1024,
  objectBytes: 20 * 1024 * 1024,
  imagePixels: 40_000_000,
  parts: 4096,
  partRecords: 2000,
  records: 100_000,
  images: 1_000_000,
  imageBytes: 100 * 1024 * 1024 * 1024,
});

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).refine(v => !/[\r\n]/.test(v));
const hash = z.string().length(64).regex(/^[a-f0-9]+$/);
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = safeInteger.refine(v => v > 0);
const text = z.string().min(1).max(50_000).refine(v => !!v.trim());
const prefix = z.string().min(2).max(8).regex(/^[a-f0-9]+$/);

export const InspirationSnapshotRecipient = z.object({
  kind: z.literal('library'),
  origin: z.string().url().refine(value => {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value;
  }),
  library_id: id,
}).strict();

export const InspirationSnapshotPartDescriptor = z.object({
  prefix,
  sha256: hash,
  size: safeInteger.refine(v => v > 0 && v <= INSPIRATION_SNAPSHOT_LIMITS.partBytes),
  records_count: z.number().int().min(1).max(INSPIRATION_SNAPSHOT_LIMITS.partRecords),
}).strict();

export const InspirationSnapshotObjectDescriptor = z.object({
  path: z.string().max(80).regex(/^images\/[a-f0-9]{64}\.(?:png|jpg|jpeg|webp)$/).refine(v => !/[\r\n]/.test(v)),
  sha256: hash,
  size: z.number().int().min(1).max(INSPIRATION_SNAPSHOT_LIMITS.objectBytes),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().min(1).max(INSPIRATION_SNAPSHOT_LIMITS.imagePixels),
  height: z.number().int().min(1).max(INSPIRATION_SNAPSHOT_LIMITS.imagePixels),
}).strict().superRefine((value, context) => {
  if (value.width * value.height > INSPIRATION_SNAPSHOT_LIMITS.imagePixels) context.addIssue({code: 'custom', message: 'Image pixel limit'});
  if (!value.path.startsWith(`images/${value.sha256}.`)) context.addIssue({code: 'custom', message: 'Object path checksum mismatch'});
  const extension = value.path.slice(value.path.lastIndexOf('.') + 1);
  const mime = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
  if (value.mime !== mime) context.addIssue({code: 'custom', message: 'Object path format mismatch'});
});

/** The existing case schema/evidence rules are applied by the server validator. */
export const InspirationSnapshotRecord = z.object({
  op: z.literal('upsert'),
  case_id: id,
  revision: positive,
  content_hash: hash,
  case: z.record(z.unknown()),
}).strict();

export const InspirationSnapshotPart = z.object({
  schema_version: z.literal(3),
  prefix,
  records: z.array(InspirationSnapshotRecord).min(1).max(INSPIRATION_SNAPSHOT_LIMITS.partRecords),
  objects: z.array(InspirationSnapshotObjectDescriptor).min(1).max(INSPIRATION_SNAPSHOT_LIMITS.images),
}).strict();

export const InspirationSnapshotManifest = z.object({
  schema_version: z.literal(3),
  kind: z.literal('snapshot'),
  recipient: InspirationSnapshotRecipient,
  release_id: id,
  sequence: positive,
  parent_release_id: id.nullable(),
  created_at: z.string().datetime().refine(v => !/[\r\n]/.test(v)),
  taxonomy_version: text,
  request_hash: hash,
  records_count: z.number().int().min(0).max(INSPIRATION_SNAPSHOT_LIMITS.records),
  image_count: z.number().int().min(0).max(INSPIRATION_SNAPSHOT_LIMITS.images),
  image_bytes: z.number().int().min(0).max(INSPIRATION_SNAPSHOT_LIMITS.imageBytes),
  withdrawal_sequence: safeInteger,
  parts: z.array(InspirationSnapshotPartDescriptor).max(INSPIRATION_SNAPSHOT_LIMITS.parts),
  key_id: id,
  signature: z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

export type InspirationSnapshotRecipient = z.infer<typeof InspirationSnapshotRecipient>;
export type InspirationSnapshotPartDescriptor = z.infer<typeof InspirationSnapshotPartDescriptor>;
export type InspirationSnapshotObjectDescriptor = z.infer<typeof InspirationSnapshotObjectDescriptor>;
export type InspirationSnapshotRecord = z.infer<typeof InspirationSnapshotRecord>;
export type InspirationSnapshotPart = z.infer<typeof InspirationSnapshotPart>;
export type InspirationSnapshotManifest = z.infer<typeof InspirationSnapshotManifest>;
