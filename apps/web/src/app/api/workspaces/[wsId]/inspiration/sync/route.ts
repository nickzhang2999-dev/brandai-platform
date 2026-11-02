import { prisma } from '@brandai/db';
import { ApiException, handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { requireEnabled } from '@/lib/inspiration/service';
import { contentSyncMode, inspirationEnabled, syncConfigured } from '@/lib/inspiration/config';
import { lockWorkspace } from '@/lib/inspiration/replica';
import { InspirationReceiveStatus } from '@brandai/contracts';

const timeoutMessage = '接收任务已超时，可重新接收；已接收的内容保留。';
const failureMessage = '接收未完成，请重试或联系管理员检查发布连接。已接收的内容保留。';
const active = ['PENDING', 'RUNNING'];

export async function GET(_req: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser(), { wsId } = await params;
    const { role } = await requireWorkspaceRole(wsId, user.id, 'VIEWER');
    const enabled = inspirationEnabled(), configured = syncConfigured(), mode = contentSyncMode(), now = new Date();
    // In manual mode an old unconfirmed automatic queue item is not running
    // reception. Keep the button available so POST can confirm that same task.
    const visibleTasks = mode === 'manual' ? { OR: [
      { status: { not: 'PENDING' as const } }, { inputJson: { path: ['trigger'], equals: 'manual' } },
    ] } : {};
    // Disabled installations expose capability state, never stored task history.
    const select = { id: true, status: true, createdAt: true, updatedAt: true, expiresAt: true } as const;
    const pending = enabled ? await prisma.asyncTask.findFirst({
      where: { workspaceId: wsId, kind: 'INSPIRATION_SYNC', status: { in: ['PENDING', 'RUNNING'] }, expiresAt: { gt: now }, ...visibleTasks },
      orderBy: { createdAt: 'desc' }, select,
    }) : null;
    const latest = pending ?? (enabled ? await prisma.asyncTask.findFirst({
      where: { workspaceId: wsId, kind: 'INSPIRATION_SYNC', ...visibleTasks }, orderBy: { createdAt: 'desc' }, select,
    }) : null);
    const expired = latest && active.includes(latest.status) && (!latest.expiresAt || latest.expiresAt <= now);
    const task = latest ? {
      id: latest.id, status: expired ? 'FAILED' : latest.status,
      error: expired ? timeoutMessage : latest.status === 'FAILED' ? failureMessage : null,
      createdAt: latest.createdAt.toISOString(), updatedAt: latest.updatedAt.toISOString(), expiresAt: latest.expiresAt?.toISOString() ?? null,
    } : null;
    return ok(InspirationReceiveStatus.parse({ enabled, configured, mode, canReceive: enabled && configured && role === 'OWNER', task }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return handleError(error); }
}

export async function POST(_req: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser(), { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, 'OWNER');
    requireEnabled();
    if (!syncConfigured()) throw new ApiException(503, '知识发布连接尚未配置。');
    const task = await prisma.$transaction(async tx => {
      await lockWorkspace(tx, wsId);
      await tx.inspirationState.upsert({ where: { workspaceId: wsId }, create: { workspaceId: wsId }, update: {} });
      const existing = await tx.asyncTask.findFirst({ where: { workspaceId: wsId, kind: 'INSPIRATION_SYNC', status: { in: ['PENDING', 'RUNNING'] }, expiresAt: { gt: new Date() } } });
      // A click also confirms a queued task from an older automatic worker.
      // Keep its identity instead of creating a second importer.
      if (existing) return tx.asyncTask.update({ where: { id: existing.id }, data: { inputJson: { trigger: 'manual', userId: user.id } } });
      return tx.asyncTask.create({ data: { workspaceId: wsId, kind: 'INSPIRATION_SYNC', expiresAt: new Date(Date.now() + 6 * 60000), inputJson: { trigger: 'manual', userId: user.id } } });
    });
    return ok({ id: task.id, status: task.status }, { status: 202 });
  } catch (error) { return handleError(error); }
}
