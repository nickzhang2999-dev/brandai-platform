import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ owner: vi.fn(), member: vi.fn(), count: vi.fn(), records: vi.fn(), legacyRecords: vi.fn(),
  oldTasks: vi.fn(), newTasks: vi.fn(), chats: vi.fn(), legacyChats: vi.fn(), empty: vi.fn(), transaction: vi.fn(),
  lock: vi.fn(), execute: vi.fn(), receipt: vi.fn(), remove: vi.fn() }));
vi.mock('@brandai/db', () => ({ Prisma: { PrismaClientKnownRequestError: class extends Error {} }, prisma: { $transaction: f.transaction } }));
vi.mock('@/lib/api', () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { deleteBrand, previewBrandDeletion } from '../src/lib/brand-deletion';
const db = () => ({
  brandWorkspace: { findUnique: f.owner, delete: f.remove }, membership: { count: f.count, findUnique: f.member },
  project: { count: f.count }, asset: { count: f.count }, brandRule: { count: f.count }, complianceTerm: { count: f.count }, prohibitionRule: { count: f.count },
  inspirationRecord: { findMany: f.records }, legacyInspirationRecord: { findMany: f.legacyRecords },
  asyncTask: { findMany: f.oldTasks }, inspirationLibraryTask: { findMany: f.newTasks },
  inspirationChat: { findMany: f.chats }, legacyInspirationChat: { findMany: f.legacyChats },
  generation: { findMany: f.empty }, studioGenerationRequest: { findMany: f.empty }, studioConversationMessage: { findMany: f.empty },
  studioDecompositionRequest: { findMany: f.empty }, studioGeneratedMaterial: { findMany: f.empty },
  brandDeletionReceipt: { findUnique: f.receipt }, $queryRaw: f.lock, $executeRaw: f.execute,
});
beforeEach(() => {
  vi.resetAllMocks(); f.owner.mockResolvedValue({ id: 'ws', name: 'Synthetic brand', ownerId: 'owner' });
  f.count.mockResolvedValue(0); f.member.mockResolvedValue(null); f.lock.mockResolvedValue([{ id: 'ws' }]); f.receipt.mockResolvedValue(null);
  for (const mock of [f.records, f.legacyRecords, f.oldTasks, f.newTasks, f.chats, f.legacyChats, f.empty]) mock.mockResolvedValue([]);
  f.transaction.mockImplementation(async work => work(db()));
});
describe('brand deletion sees both physical inspiration stores', () => {
  it('blocks an isolated library task, using workspace and active statuses without ignoring expired work', async () => {
    f.newTasks.mockResolvedValue([{ id: 'new-task' }]);
    expect(await previewBrandDeletion('ws', 'owner')).toMatchObject({ activeTasks: 1, canDelete: false });
    expect(f.newTasks).toHaveBeenCalledWith({ where: { workspaceId: 'ws', status: { in: ['PENDING', 'RUNNING'] } }, select: { id: true } });
  });
  it('counts one receipt once across both task stores and their chat projections', async () => {
    f.oldTasks.mockResolvedValue([{ id: 'copied' }, { id: 'legacy-only' }]); f.newTasks.mockResolvedValue([{ id: 'copied' }, { id: 'new-only' }]);
    f.chats.mockResolvedValue([{ id: 'new-only' }]); f.legacyChats.mockResolvedValue([{ id: 'copied' }, { id: 'legacy-chat-only' }]);
    expect((await previewBrandDeletion('ws', 'owner')).activeTasks).toBe(4);
  });
  it('includes private records created by either runtime but counts the copied identity once', async () => {
    f.records.mockResolvedValue([{ id: 'copied' }, { id: 'new-only' }]); f.legacyRecords.mockResolvedValue([{ id: 'copied' }, { id: 'legacy-only' }]);
    expect((await previewBrandDeletion('ws', 'owner')).counts.inspirationCases).toBe(3);
    expect(f.records).toHaveBeenCalledWith({ where: { library: { kind: 'WORKSPACE', legacyWorkspaceId: 'ws' } }, select: { id: true } });
    expect(f.legacyRecords).toHaveBeenCalledWith({ where: { workspaceId: 'ws' }, select: { id: true } });
  });
  it('rechecks tasks after confirmation and refuses deletion if a new queue became active', async () => {
    const preview = await previewBrandDeletion('ws', 'owner'); f.newTasks.mockResolvedValue([{ id: 'new-task' }]);
    await expect(deleteBrand('ws', 'owner', { confirmationName: preview.name, confirmationToken: preview.confirmationToken,
      mutationId: 'ad717f54-3ddd-4afd-8aca-392ab1624656' })).rejects.toMatchObject({ status: 409 });
    expect(f.remove).not.toHaveBeenCalled();
  });
});
