import { z } from 'zod';
import type { PublishedCase } from './protocol';
import type { LibraryInput } from './library-scope';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LibraryRecipient = z.object({kind:z.literal('library'),origin:z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&u.origin===value;}),library_id:id}).strict();
const basisFields={policy_id: id, policy_sha256: hash,
  purpose: z.literal('company_internal_inspiration'), authorized_at: z.string().datetime({ offset: true }),
  source_id: id, asset_id: id, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: hash, input_binding: hash,
  authorization_source: z.literal('operator_policy'),
};
export const PublicationUseBasis = z.discriminatedUnion('schema_version',[
  z.object({...basisFields,schema_version:z.literal(1),recipient:z.object({ origin: z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && u.origin === value; }), workspace_id: id }).strict()}).strict(),
  z.object({...basisFields,schema_version:z.literal(2),recipient:LibraryRecipient}).strict(),
]);

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

export function assertEnvelopeScope(value:{schema_version:number;recipient?:unknown},input:LibraryInput,origin:string|null) {
  const library=typeof input==='string'?{id:input,kind:'WORKSPACE',legacyWorkspaceId:input}:input;
  if(library.kind==='SHARED') {
    if(value.schema_version!==2||!origin)throw new Error('Publication recipient mismatch');
    const recipient=LibraryRecipient.parse(value.recipient);
    if(recipient.library_id!==library.id||recipient.origin!==origin)throw new Error('Publication recipient mismatch');
  }else if(value.schema_version!==1||value.recipient!==undefined)throw new Error('Publication recipient mismatch');
}
export function assertPublicationScope(value: PublishedCase, input: LibraryInput, origin: string | null) {
  const library=typeof input==='string'?{id:input,kind:'WORKSPACE',legacyWorkspaceId:input}:input;
  const basis = validatePublicationBinding(value);
  if(library.kind==='SHARED') {
    if(!basis||basis.schema_version!==2||!origin||basis.recipient.origin!==origin||basis.recipient.library_id!==library.id)throw new Error('Publication recipient mismatch');
  }else if(basis&&(basis.schema_version!==1||!origin||basis.recipient.origin!==origin||basis.recipient.workspace_id!==library.legacyWorkspaceId))throw new Error('Publication recipient mismatch');
}
