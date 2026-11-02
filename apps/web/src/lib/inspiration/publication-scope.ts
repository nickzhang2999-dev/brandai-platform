import { z } from 'zod';
import type { PublishedCase } from './protocol';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PublicationUseBasis = z.object({
  schema_version: z.literal(1), policy_id: id, policy_sha256: hash,
  purpose: z.literal('company_internal_inspiration'), authorized_at: z.string().datetime({ offset: true }),
  source_id: id, asset_id: id, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: hash, input_binding: hash,
  recipient: z.object({ origin: z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && u.origin === value; }), workspace_id: id }).strict(),
  authorization_source: z.literal('operator_policy'),
}).strict();

export function publicationUseBasis(value: PublishedCase) {
  const editorial = value.editorial;
  if (!editorial || typeof editorial !== 'object' || Array.isArray(editorial) || !('publication_use_basis' in editorial)) return null;
  return PublicationUseBasis.parse(editorial.publication_use_basis);
}

export function validatePublicationBinding(value: PublishedCase) {
  const basis = publicationUseBasis(value);
  if (!basis) return null;
  if (basis.asset_id !== value.case_id || basis.revision !== value.revision || value.images.length !== 1) throw new Error('Publication source binding mismatch');
  // A single-asset grant cannot authorize additional images in the same case.
  if (!new RegExp(`^images/${basis.sha256}\\.(?:png|jpe?g|webp)$`).test(value.images[0]!.path)) throw new Error('Publication image binding mismatch');
  return basis;
}

export function assertPublicationScope(value: PublishedCase, workspaceId: string, origin: string | null) {
  const basis = validatePublicationBinding(value);
  if (basis && (!origin || basis.recipient.origin !== origin || basis.recipient.workspace_id !== workspaceId)) throw new Error('Publication recipient mismatch');
}
