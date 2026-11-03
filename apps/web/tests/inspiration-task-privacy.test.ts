import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ legacy: vi.fn(), library: vi.fn(), workspace: vi.fn(), member: vi.fn(), user: vi.fn() }));
vi.mock('@brandai/db', () => ({ prisma: {
  asyncTask: { findUnique: db.legacy }, inspirationLibraryTask: { findUnique: db.library },
  brandWorkspace: { findUnique: db.workspace },
} }));
vi.mock('@/lib/api', () => ({
  requireUser: db.user,
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  ok: (value: unknown) => Response.json(value),
  handleError: (error: { status?: number }) => Response.json({ error: 'not available' }, { status: error.status ?? 500 }),
}));
vi.mock('@/lib/workspace', () => ({ requireOwnedWorkspace: db.member }));
import { getTask } from '../src/lib/async-tasks';
import { GET } from '../src/app/api/workspaces/[wsId]/tasks/[taskId]/route';
const task = (kind = 'INSPIRATION_CHAT') => ({
  id: 'task', workspaceId: 'ws', kind, inputJson: { userId: 'author', conversationId: 'private' },
  resultJson: { answer: 'private text' }, status: 'SUCCEEDED', progress: 100, refCount: 0,
  createdAt: new Date(), updatedAt: new Date(),
});
const libraryTask = (kind = 'INSPIRATION_CHAT') => ({ ...task(kind),
  inspirationLibrary: { ownerId: 'owner', kind: 'SHARED', legacyWorkspaceId: null },
});
beforeEach(() => {
  vi.resetAllMocks(); db.legacy.mockResolvedValue(task()); db.library.mockResolvedValue(null);
  db.workspace.mockResolvedValue({ ownerId: 'owner' }); db.user.mockResolvedValue({ id: 'author' });
  db.member.mockResolvedValue({ id: 'ws' });
});

describe('generic task polling preserves legacy identity and private library tasks', () => {
  it('rejects a different workspace without checking a colliding library id', async () => {
    db.library.mockResolvedValue(libraryTask());
    expect(await getTask('other', 'task', 'author')).toBeNull(); expect(db.library).not.toHaveBeenCalled();
  });
  it('never exposes service-only image jobs through browser task polling', async () => {
    db.legacy.mockResolvedValue(task('OMNI_INSPIRATION_ANALYSIS'));
    expect(await getTask('ws', 'task', 'author')).toBeNull(); expect(db.library).not.toHaveBeenCalled();
  });
  it('rejects other members and missing initiator context for legacy private tasks', async () => {
    expect(await getTask('ws', 'task', 'member')).toBeNull(); expect(await getTask('ws', 'task')).toBeNull();
    expect(db.library).not.toHaveBeenCalled();
  });
  it('returns only metadata to the legacy initiator', async () => {
    const value = await getTask('ws', 'task', 'author');
    expect(value?.status).toBe('SUCCEEDED'); expect(value).not.toHaveProperty('inputJson');
    expect(value).not.toHaveProperty('result'); expect(JSON.stringify(value)).not.toContain('private');
  });
  it('keeps the existing row authoritative when both task tables contain the id', async () => {
    db.library.mockResolvedValue({ ...libraryTask(), status: 'FAILED' });
    expect((await getTask('ws', 'task', 'author'))?.status).toBe('SUCCEEDED'); expect(db.library).not.toHaveBeenCalled();
  });
  it.each(['INSPIRATION_CHAT', 'INSPIRATION_SYNC'])('reads isolated %s only for its initiator', async kind => {
    db.legacy.mockResolvedValue(null); db.library.mockResolvedValue(libraryTask(kind));
    expect(await getTask('ws', 'task', 'member')).toBeNull(); expect(await getTask('ws', 'task')).toBeNull();
    const value = await getTask('ws', 'task', 'author'); expect(value).toMatchObject({ kind, status: 'SUCCEEDED' });
    expect(value).not.toHaveProperty('inputJson'); expect(value).not.toHaveProperty('inspirationLibrary'); expect(value).not.toHaveProperty('result');
  });
  it('never treats an unknown new-table kind as a public task', async () => {
    db.legacy.mockResolvedValue(null); db.library.mockResolvedValue(libraryTask('UNRECOGNIZED_KIND'));
    expect(await getTask('ws', 'task', 'author')).toBeNull(); expect(db.workspace).not.toHaveBeenCalled();
  });
  it('rejects another workspace even when it has the same owner', async () => {
    db.legacy.mockResolvedValue(null); db.library.mockResolvedValue(libraryTask());
    expect(await getTask('other', 'task', 'author')).toBeNull(); expect(db.workspace).not.toHaveBeenCalled();
  });
  it('rejects a changed tenant owner, deleted brand, deleted library and mismatched private scope', async () => {
    db.legacy.mockResolvedValue(null); db.library.mockResolvedValue(libraryTask());
    db.workspace.mockResolvedValue({ ownerId: 'another-owner' }); expect(await getTask('ws', 'task', 'author')).toBeNull();
    db.workspace.mockResolvedValue(null); expect(await getTask('ws', 'task', 'author')).toBeNull();
    db.workspace.mockResolvedValue({ ownerId: 'owner' }); db.library.mockResolvedValue({ ...libraryTask(), inspirationLibrary: null });
    expect(await getTask('ws', 'task', 'author')).toBeNull();
    db.library.mockResolvedValue({ ...libraryTask(), inspirationLibrary: { ownerId: 'owner', kind: 'WORKSPACE', legacyWorkspaceId: 'other' } });
    expect(await getTask('ws', 'task', 'author')).toBeNull();
  });
  it('does not expose scheduled tasks without a user-bound manual request', async () => {
    db.legacy.mockResolvedValue(null); db.library.mockResolvedValue({ ...libraryTask('INSPIRATION_SYNC'), inputJson: { trigger: 'automatic' } });
    expect(await getTask('ws', 'task', 'author')).toBeNull();
  });
  it('returns null when neither table has the task', async () => {
    db.legacy.mockResolvedValue(null); expect(await getTask('ws', 'missing', 'author')).toBeNull();
  });
});

describe('generic task HTTP membership boundary', () => {
  const params = { params: Promise.resolve({ wsId: 'ws', taskId: 'task' }) };
  it.each([401, 404])('rejects authentication or membership failure before any task lookup (%i)', async status => {
    (status === 401 ? db.user : db.member).mockRejectedValue({ status });
    expect((await GET(new Request('https://test.invalid'), params)).status).toBe(status);
    expect(db.legacy).not.toHaveBeenCalled(); expect(db.library).not.toHaveBeenCalled();
  });
  it('keeps membership plus initiator gating for a new library task', async () => {
    db.legacy.mockResolvedValue(null); db.library.mockResolvedValue(libraryTask()); db.user.mockResolvedValue({ id: 'member' });
    expect((await GET(new Request('https://test.invalid'), params)).status).toBe(404);
    expect(db.member).toHaveBeenCalledWith('ws', 'member');
    db.user.mockResolvedValue({ id: 'author' }); expect((await GET(new Request('https://test.invalid'), params)).status).toBe(200);
  });
});
