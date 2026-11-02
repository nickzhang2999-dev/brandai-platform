import { describe, expect, it } from 'vitest';
import { InspirationBookmarkInput, InspirationCaseCard, InspirationChatInput, InspirationChatState, InspirationFeedbackInput, InspirationLibraryCreateInput, InspirationLibraryCreateResult, InspirationListResponse, InspirationReceiveStatus, InspirationSelectedImage, InspirationSourceLibrary } from '../src/inspiration';

const library = { id: 'deepflare-company-inspiration', kind: 'SHARED' as const };
const requestId = 'c78bfd95-d837-47de-a13c-aae41b32ea3f';
const image = { caseId: 'same-case', imageId: 'image-1', revision: 1 };
const card = { caseId: 'same-case', revision: 1, title: 'Synthetic', summary: '', brandOrTeam: '', analysisAllowed: true, tags: {}, images: [], sources: [], claims: [] };

describe('inspiration source library wire identity', () => {
  it('requires explicit bounded admin input and rejects caller-provided library attributes', () => {
    const input = { libraryId: library.id, ownerId: 'synthetic-owner' };
    expect(InspirationLibraryCreateInput.parse(input)).toEqual(input);
    for (const extra of [{ ownerId: '' }, { ownerId: null }, { ownerId: 'a'.repeat(129) }, { libraryId: '../escape' }, { kind: 'SHARED' }, { created: true }]) {
      expect(InspirationLibraryCreateInput.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(InspirationLibraryCreateInput.safeParse({ libraryId: library.id }).success).toBe(false);
  });
  it('returns library identity and idempotent creation status without owner details', () => {
    for (const created of [true, false]) expect(InspirationLibraryCreateResult.parse({ sourceLibrary: library, created })).toEqual({ sourceLibrary: library, created });
    for (const value of [{ sourceLibrary: null, created: true }, { sourceLibrary: library }, { sourceLibrary: library, created: 'true' }]) {
      expect(InspirationLibraryCreateResult.safeParse(value).success).toBe(false);
    }
    expect(InspirationLibraryCreateResult.parse({ sourceLibrary: library, created: false, ownerId: 'synthetic-owner' })).not.toHaveProperty('ownerId');
  });
  it('supports explicit shared and historical workspace libraries', () => {
    expect(InspirationSourceLibrary.parse(library)).toEqual(library);
    expect(InspirationSourceLibrary.parse({ ...library, kind: 'WORKSPACE' }).kind).toBe('WORKSPACE');
    for (const id of ['', '../other', '/library', 'a?b']) expect(InspirationSourceLibrary.safeParse({ ...library, id }).success).toBe(false);
    expect(InspirationSourceLibrary.safeParse({ ...library, kind: 'PUBLIC' }).success).toBe(false);
  });
  it('pins every write and selected image while retaining old inputs', () => {
    for (const [schema, input] of [
      [InspirationChatInput, { requestId, question: 'Synthetic question', selectedImages: [{ ...image, libraryId: library.id }] }],
      [InspirationBookmarkInput, { caseId: image.caseId, revision: 1, projectId: 'destination-project' }],
      [InspirationFeedbackInput, { caseId: image.caseId, revision: 1, kind: 'IRRELEVANT' }],
      [InspirationSelectedImage, image],
    ] as const) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.parse({ ...input, libraryId: library.id }).libraryId).toBe(library.id);
      for (const libraryId of [null, '../escape', '']) expect(schema.safeParse({ ...input, libraryId }).success).toBe(false);
    }
    expect(InspirationCaseCard.parse({ ...card, libraryId: library.id }).libraryId).toBe(library.id);
    expect(InspirationCaseCard.safeParse({ ...card, libraryId: null }).success).toBe(false);
  });
  it('reports a source library and early receive reason without exposing configuration', () => {
    const status = { enabled: true, configured: true, mode: 'manual', canReceive: false, task: null };
    expect(InspirationReceiveStatus.safeParse(status).success).toBe(true);
    expect(InspirationReceiveStatus.parse({ ...status, sourceLibrary: library, canReceiveReason: '请联系公司灵感库管理员。' }).sourceLibrary).toEqual(library);
    expect(InspirationReceiveStatus.parse({ ...status, sourceLibrary: null, canReceiveReason: null }).sourceLibrary).toBeNull();
    const listing = { enabled: true, syncConfigured: true, activeRelease: null, caseCount: 0, withdrawalSequence: 0, lastSyncAt: null, error: null, cases: [], searchMode: 'keyword-tags' };
    expect(InspirationListResponse.parse({ ...listing, sourceLibrary: library }).sourceLibrary).toEqual(library);
    const chat = { id: 'chat-1', conversationId: requestId, status: 'SUCCEEDED', question: '', answer: '', citations: [], error: null, createdAt: '' };
    expect(InspirationChatState.parse({ ...chat, sourceLibrary: { ...library, kind: 'WORKSPACE' } }).sourceLibrary?.kind).toBe('WORKSPACE');
  });
});
