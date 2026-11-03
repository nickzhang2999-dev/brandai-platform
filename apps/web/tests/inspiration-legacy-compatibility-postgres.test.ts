import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@brandai/db';

const isolated = process.env.INSPIRATION_LIBRARY_TEST_DATABASE_URL;
const suite = isolated ? describe : describe.skip;

// Synthetic, local database acceptance. Legacy delegates map the SQL interface
// used by main; these checks do not claim provider or live deployment acceptance.
suite('legacy and shared inspiration physical-store isolation', () => {
  let owner: string, workspace: string, shared: string, extraWorkspace: string;
  beforeAll(() => {
    const url = new URL(isolated!);
    if (url.hostname !== '127.0.0.1' || url.port !== '55439'
      || !['/nova_shared_inspiration_test', '/nova_inspiration_compat_test'].includes(url.pathname)
      || process.env.DATABASE_URL !== isolated) throw new Error('Explicit isolated library PostgreSQL required');
  });
  beforeEach(async () => {
    const prefix = 'legacy-compat-' + randomUUID();
    owner = prefix + '-owner'; workspace = prefix + '-brand'; shared = prefix + '-shared'; extraWorkspace = prefix + '-old-brand';
    await prisma.user.create({ data: { id: owner, email: owner + '@example.invalid' } });
    await prisma.brandWorkspace.createMany({ data: [workspace, extraWorkspace].map(id => ({ id, ownerId: owner, name: 'Synthetic compatibility brand' })) });
    await prisma.inspirationLibrary.createMany({ data: [
      { id: workspace, kind: 'WORKSPACE', ownerId: owner, legacyWorkspaceId: workspace },
      { id: shared, kind: 'SHARED', ownerId: owner, legacyWorkspaceId: null },
    ] });
  });
  afterEach(async () => {
    if (!owner) return;
    const scope = { workspaceId: { in: [workspace, extraWorkspace] } };
    await prisma.inspirationLibraryTask.deleteMany({ where: scope });
    await prisma.asyncTask.deleteMany({ where: scope });
    // A failing assertion must not leave an active domain row blocking cleanup.
    await prisma.inspirationChat.deleteMany({ where: scope });
    await prisma.legacyInspirationChat.deleteMany({ where: scope });
    await prisma.user.deleteMany({ where: { id: owner } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  const record = (libraryId: string, id: string) => prisma.inspirationRecord.create({ data: {
    id, libraryId, caseId: 'synthetic-case', revision: 1, contentHash: 'a'.repeat(64), imageHash: 'b'.repeat(64),
    releaseId: 'synthetic-release', body: { synthetic: true },
  } });
  const chat = (id: string) => ({ id, workspaceId: workspace, userId: owner, requestId: randomUUID(),
    conversationId: randomUUID(), question: 'Synthetic compatibility question', caseIds: [], expiresAt: new Date(Date.now() + 60_000) });

  it('keeps shared state, release, case and image outside every legacy replica query', async () => {
    await prisma.inspirationState.create({ data: { libraryId: shared, activeRelease: 'synthetic-release', releaseSequence: 1 } });
    await prisma.inspirationRelease.create({ data: { libraryId: shared, releaseId: 'synthetic-release', sequence: 1,
      manifestHash: 'c'.repeat(64), manifest: { synthetic: true }, snapshot: {} } });
    await record(shared, shared + '-record');
    await prisma.inspirationImage.create({ data: { libraryId: shared, releaseId: 'synthetic-release', path: 'images/synthetic.png',
      sha256: 'd'.repeat(64), mimeType: 'image/png', bytes: Buffer.from([0, 1, 2, 255]) } });
    for (const model of [prisma.legacyInspirationState, prisma.legacyInspirationRelease, prisma.legacyInspirationRecord, prisma.legacyInspirationImage]) {
      expect(await model.count({ where: { workspaceId: { in: [workspace, shared] } } })).toBe(0);
    }
    expect(await prisma.inspirationRecord.count({ where: { libraryId: shared } })).toBe(1);
    expect(Buffer.from((await prisma.inspirationImage.findFirstOrThrow({ where: { libraryId: shared } })).bytes)).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('hides new chats and queued work from old workers scanning legacy tables', async () => {
    const id = workspace + '-chat';
    await prisma.inspirationChat.create({ data: { ...chat(id), libraryId: shared } });
    await prisma.inspirationLibraryTask.create({ data: { id, workspaceId: workspace, inspirationLibraryId: shared,
      kind: 'INSPIRATION_CHAT', inputJson: { userId: owner } } });
    expect(await prisma.legacyInspirationChat.count({ where: { workspaceId: workspace, status: 'PENDING' } })).toBe(0);
    expect(await prisma.asyncTask.count({ where: { workspaceId: workspace, kind: 'INSPIRATION_CHAT' } })).toBe(0);
    expect((await prisma.legacyInspirationChat.updateMany({ where: { workspaceId: workspace, status: 'PENDING' }, data: { status: 'FAILED' } })).count).toBe(0);
    expect((await prisma.asyncTask.updateMany({ where: { workspaceId: workspace, kind: 'INSPIRATION_CHAT' }, data: { status: 'FAILED' } })).count).toBe(0);
    expect((await prisma.inspirationChat.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    expect((await prisma.inspirationLibraryTask.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
  });

  it('allows an old writer to create private data for a new brand without a library row', async () => {
    expect(await prisma.inspirationLibrary.findUnique({ where: { id: extraWorkspace } })).toBeNull();
    await prisma.legacyInspirationState.create({ data: { workspaceId: extraWorkspace } });
    await prisma.legacyInspirationRecord.create({ data: { workspaceId: extraWorkspace, caseId: 'old-case', revision: 1,
      contentHash: 'a'.repeat(64), imageHash: 'b'.repeat(64), releaseId: 'old-release', body: { synthetic: true } } });
    await prisma.legacyInspirationChat.create({ data: { ...chat(extraWorkspace + '-chat'), workspaceId: extraWorkspace, status: 'SUCCEEDED' } });
    await prisma.legacyInspirationFeedback.create({ data: { workspaceId: extraWorkspace, userId: owner,
      caseId: 'old-case', revision: 1, kind: 'BROKEN_IMAGE' } });
    expect(await prisma.legacyInspirationRecord.count({ where: { workspaceId: extraWorkspace } })).toBe(1);
    expect(await prisma.inspirationState.findUnique({ where: { libraryId: extraWorkspace } })).toBeNull();
    expect(await prisma.inspirationChat.count({ where: { workspaceId: extraWorkspace } })).toBe(0);
  });

  it('preserves the old bookmark upsert key while new bookmarks distinguish source libraries', async () => {
    const oldKey = { workspaceId_userId_caseId_projectId: { workspaceId: workspace, userId: owner, caseId: 'same-case', projectId: '' } };
    const base = { workspaceId: workspace, userId: owner, caseId: 'same-case', revision: 1 };
    await prisma.legacyInspirationBookmark.upsert({ where: oldKey, create: base, update: { note: 'first' } });
    await prisma.legacyInspirationBookmark.upsert({ where: oldKey, create: base, update: { note: 'updated old bookmark' } });
    await prisma.inspirationBookmark.createMany({ data: [workspace, shared].map(libraryId => ({ ...base, libraryId, note: 'new bookmark' })) });
    expect((await prisma.legacyInspirationBookmark.findUniqueOrThrow({ where: oldKey })).note).toBe('updated old bookmark');
    expect(await prisma.legacyInspirationBookmark.count({ where: { workspaceId: workspace } })).toBe(1);
    expect(await prisma.inspirationBookmark.count({ where: { workspaceId: workspace } })).toBe(2);
  });

  it('keeps later state, withdrawal and cache writes independent in both directions', async () => {
    await prisma.legacyInspirationState.create({ data: { workspaceId: workspace, withdrawalSequence: 2 } });
    await prisma.inspirationState.create({ data: { libraryId: workspace, withdrawalSequence: 2 } });
    await prisma.legacyInspirationState.update({ where: { workspaceId: workspace }, data: { withdrawalSequence: 3, withdrawn: ['old-only'] } });
    expect((await prisma.inspirationState.findUniqueOrThrow({ where: { libraryId: workspace } })).withdrawalSequence).toBe(2);
    await prisma.inspirationState.update({ where: { libraryId: workspace }, data: { withdrawalSequence: 7, withdrawn: ['new-only'] } });
    expect((await prisma.legacyInspirationState.findUniqueOrThrow({ where: { workspaceId: workspace } })).withdrawn).toEqual(['old-only']);
    await prisma.legacyInspirationEmbedding.create({ data: { workspaceId: workspace, key: 'same-cache', payloadJson: { source: 'old' } } });
    await prisma.inspirationEmbedding.create({ data: { workspaceId: workspace, key: 'same-cache', payloadJson: { source: 'new' } } });
    expect((await prisma.legacyInspirationEmbedding.findFirstOrThrow({ where: { workspaceId: workspace } })).payloadJson).toEqual({ source: 'old' });
    expect((await prisma.inspirationEmbedding.findFirstOrThrow({ where: { workspaceId: workspace } })).payloadJson).toEqual({ source: 'new' });
  });

  it('blocks old-client brand deletion during new work, then preserves shared content and terminal receipts', async () => {
    await record(shared, shared + '-record');
    const id = workspace + '-task';
    await prisma.inspirationLibraryTask.create({ data: { id, workspaceId: workspace, inspirationLibraryId: shared, kind: 'INSPIRATION_SYNC' } });
    // A direct workspace delete is how an older deployment reaches the database:
    // it has no application-level knowledge of InspirationLibraryTask.
    await expect(prisma.brandWorkspace.delete({ where: { id: workspace } })).rejects.toThrow();
    await prisma.inspirationLibraryTask.update({ where: { id }, data: { status: 'SUCCEEDED' } });
    await prisma.brandWorkspace.delete({ where: { id: workspace } });
    expect(await prisma.inspirationRecord.count({ where: { libraryId: shared } })).toBe(1);
    expect(await prisma.inspirationLibraryTask.count({ where: { id, status: 'SUCCEEDED' } })).toBe(1);
    await expect(prisma.inspirationLibraryTask.update({ where: { id }, data: { status: 'RUNNING' } })).rejects.toThrow();
  });
});
