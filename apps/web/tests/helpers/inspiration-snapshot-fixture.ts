import { generateKeyPairSync, sign } from 'node:crypto';
import sharp from 'sharp';
import { canonical, sha256 } from '../../src/lib/inspiration/protocol';
import type { SnapshotManifest, SnapshotPart, SnapshotPartDescriptor, SnapshotObjectDescriptor } from '../../src/lib/inspiration/snapshot-protocol';

// Entirely synthetic, process-local signing material. Never exported to files.
const key = generateKeyPairSync('ed25519');
export const keys = {synthetic: key.publicKey.export({type: 'spki', format: 'pem'}).toString()};
export const recipient = {kind: 'library' as const, origin: 'https://snapshot.example.invalid', library_id: 'synthetic-library'};
export const bytes = (value: unknown) => Buffer.from(canonical(value) + '\n');
export function signed(value: Omit<SnapshotManifest, 'signature'> | SnapshotManifest): SnapshotManifest {
  const {signature: _, ...payload} = value as SnapshotManifest;
  return {...payload, signature: sign(null, Buffer.from(canonical(payload)), key.privateKey).toString('base64')};
}
export function describePart(part: SnapshotPart): SnapshotPartDescriptor {
  const raw = bytes(part);
  return {prefix: part.prefix, sha256: sha256(raw), size: raw.length, records_count: part.records.length};
}
export function replaceParts(manifest: SnapshotManifest, parts: SnapshotPart[]) {
  return signed({...manifest, records_count: parts.reduce((n, p) => n + p.records.length, 0), parts: parts.map(describePart).sort((a, b) => a.prefix < b.prefix ? -1 : 1)});
}
export async function fixture(count = 2) {
  const image = await sharp({create: {width: 3, height: 2, channels: 3, background: '#345678'}}).png().toBuffer();
  const imageHash = sha256(image);
  const object: SnapshotObjectDescriptor = {path: `images/${imageHash}.png`, sha256: imageHash, size: image.length, mime: 'image/png', width: 3, height: 2};
  const grouped = new Map<string, SnapshotPart>();
  for (let index = 0; index < count; index++) {
    const caseId = `synthetic-${String(index).padStart(6, '0')}`;
    const value = {
      case_id: caseId, revision: 1, title: '合成契约案例', summary_zh: '仅供离线协议测试。', brand_or_team: 'synthetic',
      review_status: 'approved' as const, display_permission: 'allowed' as const, analysis_version: 'synthetic', model_version: 'synthetic',
      tags: {industry: ['synthetic'], medium: ['poster']},
      sources: [{source_id: 'source', url: 'https://example.invalid/synthetic', display_permission: 'allowed' as const}],
      images: [{image_id: 'image', path: object.path, source_id: 'source', display_permission: 'allowed' as const}],
      claims: [{claim_id: 'claim', kind: 'visual_observation' as const, text: '合成色块。', source_ids: [], image_ids: ['image']}],
      editorial: {publication_use_basis: {
        schema_version: 2, recipient, policy_id: 'synthetic-policy', policy_sha256: 'a'.repeat(64),
        purpose: 'company_internal_inspiration', authorized_at: '2026-11-06T00:00:00Z', source_id: 'source', asset_id: caseId,
        revision: 1, sha256: imageHash, input_binding: 'b'.repeat(64), authorization_source: 'operator_policy',
      }},
    };
    const record = {op: 'upsert' as const, case_id: caseId, revision: 1, content_hash: sha256(canonical(value)), case: value};
    const prefix = sha256(caseId).slice(0, 2), part = grouped.get(prefix) ?? {schema_version: 3, prefix, records: [], objects: [object]};
    part.records.push(record);grouped.set(prefix, part);
  }
  const parts = [...grouped.values()].sort((a, b) => a.prefix < b.prefix ? -1 : 1);
  const manifest = signed({schema_version: 3, kind: 'snapshot', recipient, release_id: 'synthetic-release', sequence: 1,
    parent_release_id: null, created_at: '2026-11-06T00:00:00Z', taxonomy_version: 'synthetic-1', request_hash: 'c'.repeat(64),
    records_count: count, image_count: count ? 1 : 0, image_bytes: count ? image.length : 0, withdrawal_sequence: 0,
    parts: parts.map(describePart), key_id: 'synthetic'});
  return {manifest, parts, image, object};
}
