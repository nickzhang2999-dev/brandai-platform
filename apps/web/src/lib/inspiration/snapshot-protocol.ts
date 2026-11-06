import sharp from 'sharp';
import {
  INSPIRATION_SNAPSHOT_LIMITS as limits,
  InspirationSnapshotManifest,
  InspirationSnapshotObjectDescriptor,
  InspirationSnapshotPart,
  InspirationSnapshotPartDescriptor,
  InspirationSnapshotRecipient,
} from '@brandai/contracts';
import { canonical, PublishedCase, sha256, validateCase, verifySigned } from './protocol';
import { assertPublicationScope, validatePublicationBinding } from './publication-scope';

export type SnapshotManifest = InspirationSnapshotManifest;
export type SnapshotPartDescriptor = InspirationSnapshotPartDescriptor;
export type SnapshotObjectDescriptor = InspirationSnapshotObjectDescriptor;
export type SnapshotPart = Omit<InspirationSnapshotPart, 'records'> & {
  records: Array<Omit<InspirationSnapshotPart['records'][number], 'case'> & {case: PublishedCase}>;
};

function readCanonicalJson(raw: Buffer, limit: number): unknown {
  if (!raw.length || raw.length > limit) throw new Error('Snapshot metadata size limit');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  const value: unknown = JSON.parse(text);
  // In addition to deterministic hashes, this rejects duplicate JSON keys and
  // noncanonical numbers without normalizing signed fields before verification.
  if (!raw.equals(Buffer.from(canonical(value) + '\n'))) throw new Error('Noncanonical snapshot metadata');
  return value;
}

function sameRecipient(actual: InspirationSnapshotRecipient, expected: InspirationSnapshotRecipient) {
  const recipient = InspirationSnapshotRecipient.parse(expected);
  if (actual.library_id !== recipient.library_id || actual.origin !== recipient.origin) throw new Error('Publication recipient mismatch');
}

export function validateSnapshotManifest(raw: Buffer, keys: Record<string, string>, expectedRecipient: InspirationSnapshotRecipient): SnapshotManifest {
  const manifest = verifySigned(InspirationSnapshotManifest.parse(readCanonicalJson(raw, limits.manifestBytes)), keys);
  sameRecipient(manifest.recipient, expectedRecipient);
  let previous = '', total = 0;
  const hashes = new Set<string>();
  for (const part of manifest.parts) {
    if (previous && (part.prefix <= previous || part.prefix.startsWith(previous))) throw new Error('Snapshot part prefixes overlap or are unsorted');
    if (hashes.has(part.sha256)) throw new Error('Duplicate snapshot part checksum');
    hashes.add(part.sha256);previous = part.prefix;total += part.records_count;
  }
  if (total !== manifest.records_count) throw new Error('Snapshot record total mismatch');
  if (!total && (manifest.parts.length || manifest.image_count || manifest.image_bytes)) throw new Error('Nonempty inventory for empty snapshot');
  if (total && (!manifest.image_count || !manifest.image_bytes)) throw new Error('Missing snapshot image inventory');
  return manifest;
}

function descriptorIdentity(value: SnapshotObjectDescriptor): string {
  // A JPEG may have either .jpg or .jpeg; the bytes and decoded image must agree.
  return `${value.size}:${value.mime}:${value.width}:${value.height}`;
}

export function validateSnapshotPart(raw: Buffer, candidate: SnapshotPartDescriptor, manifest: SnapshotManifest): SnapshotPart {
  const descriptor = InspirationSnapshotPartDescriptor.parse(candidate);
  const declared = manifest.parts.find(p => p.prefix === descriptor.prefix);
  if (!declared || canonical(declared) !== canonical(descriptor)) throw new Error('Snapshot part is not in manifest');
  if (raw.length !== descriptor.size || sha256(raw) !== descriptor.sha256) throw new Error('Snapshot part checksum mismatch');
  const part = InspirationSnapshotPart.parse(readCanonicalJson(raw, limits.partBytes));
  if (part.prefix !== descriptor.prefix || part.records.length !== descriptor.records_count) throw new Error('Snapshot part count or prefix mismatch');
  const objects = new Map<string, SnapshotObjectDescriptor>(), objectHashes = new Map<string, string>();
  let previousPath = '';
  for (const object of part.objects) {
    if (object.path <= previousPath) throw new Error('Duplicate or unsorted snapshot object path');
    previousPath = object.path;objects.set(object.path, object);
    const identity = descriptorIdentity(object), old = objectHashes.get(object.sha256);
    if (old !== undefined && old !== identity) throw new Error('Conflicting snapshot image descriptor');
    objectHashes.set(object.sha256, identity);
  }
  const used = new Set<string>();
  let previousId = '';
  const records: SnapshotPart['records'] = [];
  for (const record of part.records) {
    if (Buffer.byteLength(canonical(record)) > limits.recordBytes) throw new Error('Snapshot record size limit');
    // case_id uses the existing ASCII stable-ID alphabet, so lexical order is
    // also Unicode codepoint order and has no locale-dependent collation.
    if (record.case_id <= previousId) throw new Error('Duplicate or unsorted snapshot case identity');
    previousId = record.case_id;
    if (!sha256(record.case_id).startsWith(part.prefix)) throw new Error('Snapshot case prefix mismatch');
    const value = PublishedCase.parse(record.case);
    if (record.case_id !== value.case_id || record.revision !== value.revision || sha256(canonical(value)) !== record.content_hash) throw new Error('Invalid case record');
    validateCase(value);
    // This reuses case-level v2 grants; v3 changes transport, never grant scope.
    assertPublicationScope(value, {id: manifest.recipient.library_id, kind: 'SHARED', ownerId: '', legacyWorkspaceId: null}, manifest.recipient.origin);
    for (const image of value.images) {
      if (!objects.has(image.path)) throw new Error('Missing snapshot image');
      used.add(image.path);
    }
    const basis = validatePublicationBinding(value);
    if (basis && objects.get(value.images[0]!.path)?.sha256 !== basis.sha256) throw new Error('Publication image checksum mismatch');
    records.push({...record, case: value});
  }
  if (used.size !== objects.size) throw new Error('Unreferenced snapshot image');
  return {...part, records};
}

/** Validate one bounded object. Callers own storage, retries, and authorization. */
export async function validateSnapshotObject(data: Buffer, candidate: SnapshotObjectDescriptor): Promise<void> {
  const object = InspirationSnapshotObjectDescriptor.parse(candidate);
  if (data.length !== object.size || sha256(data) !== object.sha256) throw new Error('Snapshot object checksum mismatch');
  const processor = sharp(data, {limitInputPixels: limits.imagePixels, failOn: 'error'});
  const metadata = await processor.metadata();
  if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error('Unsupported snapshot image');
  const mime = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`;
  if (mime !== object.mime || metadata.width !== object.width || metadata.height !== object.height) throw new Error('Snapshot image dimensions or format mismatch');
  // metadata() alone accepts some truncated images; stats() forces real decoding.
  await processor.stats();
}

/** Metadata-only complete inventory check; no image bytes are retained here. */
export function validateSnapshotInventory(manifest: SnapshotManifest, candidates: readonly SnapshotPart[]) {
  if (candidates.length !== manifest.parts.length) throw new Error('Incomplete snapshot parts');
  const seenParts = new Set<string>(), caseIds = new Set<string>(), images = new Map<string, SnapshotObjectDescriptor>();
  for (const candidate of candidates) {
    if (seenParts.has(candidate.prefix)) throw new Error('Duplicate snapshot part');
    seenParts.add(candidate.prefix);
    const descriptor = manifest.parts.find(p => p.prefix === candidate.prefix);
    if (!descriptor) throw new Error('Unexpected snapshot part');
    // Ensure this API cannot bless arbitrary parsed objects that bypassed the
    // per-part checks. Only one bounded metadata part is re-encoded at a time.
    const part = validateSnapshotPart(Buffer.from(canonical(candidate) + '\n'), descriptor, manifest);
    for (const record of part.records) {
      if (caseIds.has(record.case_id)) throw new Error('Duplicate snapshot case identity');
      caseIds.add(record.case_id);
    }
    for (const object of part.objects) {
      const previous = images.get(object.sha256);
      if (previous && descriptorIdentity(previous) !== descriptorIdentity(object)) throw new Error('Conflicting snapshot image descriptor');
      images.set(object.sha256, object);
    }
  }
  const imageBytes = [...images.values()].reduce((total, image) => total + image.size, 0);
  if (caseIds.size !== manifest.records_count || images.size !== manifest.image_count || imageBytes !== manifest.image_bytes) throw new Error('Snapshot inventory total mismatch');
  return {recordsCount: caseIds.size, imageCount: images.size, imageBytes};
}
