import { prisma } from '@brandai/db';
import { ApiException, handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { requireEnabled } from '@/lib/inspiration/service';
import { contentSyncMode, inspirationEnabled, syncConfigured } from '@/lib/inspiration/config';
import { lockWorkspace } from '@/lib/inspiration/replica';
import { InspirationReceiveStatus } from '@brandai/contracts';
import { canReceiveLibrary, ensureLibrary, resolveLibrary, sourceLibrary } from '@/lib/inspiration/library';
import {dailyImageLimitMessage,isDailyImageLimitMessage} from '@/lib/inspiration/sync-status';
import { requestedLibraryId } from '@/lib/inspiration/library-query';

const timeoutMessage = '接收任务已超时，可重新接收；已接收的内容保留。';
const failureMessage = '接收未完成，请重试或联系管理员检查发布连接。已接收的内容保留。';
const active = ['PENDING', 'RUNNING'];

export async function GET(request: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser(), { wsId } = await params;
    const { role } = await requireWorkspaceRole(wsId, user.id, 'VIEWER');
    const requestedId=requestedLibraryId(request);
    const enabled=inspirationEnabled(),library=enabled?await resolveLibrary(wsId,requestedId):null,configured=library?syncConfigured(library.kind):false,mode=contentSyncMode(),now=new Date();
    const canReceive=!!(enabled&&configured&&library&&await canReceiveLibrary(library,user,role));
    // In manual mode an old unconfirmed automatic queue item is not running
    // reception. Keep the button available so POST can confirm that same task.
    const visibleTasks = mode === 'manual' ? { OR: [
      { status: { not: 'PENDING' as const } }, { inputJson: { path: ['trigger'], equals: 'manual' } },
    ] } : {};
    // Disabled installations expose capability state, never stored task history.
    const select = { id: true, status: true, createdAt: true, updatedAt: true, expiresAt: true, error:true } as const;
    const pending = enabled&&library ? await prisma.inspirationLibraryTask.findFirst({
      where: { inspirationLibraryId: library!.id, kind: 'INSPIRATION_SYNC', status: { in: ['PENDING', 'RUNNING'] }, expiresAt: { gt: now }, ...visibleTasks },
      orderBy: { createdAt: 'desc' }, select,
    }) : null;
    const latest = pending ?? (enabled&&library ? await prisma.inspirationLibraryTask.findFirst({
      where: { inspirationLibraryId: library!.id, kind: 'INSPIRATION_SYNC', ...visibleTasks }, orderBy: { createdAt: 'desc' }, select,
    }) : null);
    const expired = latest && active.includes(latest.status) && (!latest.expiresAt || latest.expiresAt <= now);
    const task = latest ? {
      id: latest.id, status: expired ? 'FAILED' : latest.status,
      error: expired ? timeoutMessage : latest.status === 'FAILED' ? (isDailyImageLimitMessage(latest.error)?dailyImageLimitMessage(mode):['发布包与当前灵感库的接收范围不一致，请联系管理员检查库配置。','接收权限已变化，请由当前灵感库管理员重新确认。','灵感接收超时，已有内容保留。','灵感库存储容量不足，已保存接收进度，已有内容保留。'].includes(latest.error||'')?latest.error:failureMessage) : null,
      createdAt: latest.createdAt.toISOString(), updatedAt: latest.updatedAt.toISOString(), expiresAt: latest.expiresAt?.toISOString() ?? null,
    } : null;
    return ok(InspirationReceiveStatus.parse({ enabled, configured, mode, canReceive,canReceiveReason:canReceive?null:configured?'只有公司灵感库管理员或所有者可以接收新内容。':'灵感库连接尚未配置。',sourceLibrary:library?sourceLibrary(library):null,task }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return handleError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser(), { wsId } = await params;
    const {role}=await requireWorkspaceRole(wsId,user.id,'VIEWER');
    requireEnabled();
    const library=await resolveLibrary(wsId,requestedLibraryId(request));
    if(!await canReceiveLibrary(library,user,role))throw new ApiException(403,'只有公司灵感库管理员或所有者可以接收新内容。');
    if (!syncConfigured(library.kind)) throw new ApiException(503, '知识发布连接尚未配置。');
    const task = await prisma.$transaction(async tx => {
      await lockWorkspace(tx,library.id);
      await ensureLibrary(tx,library);
      await tx.inspirationState.upsert({ where: { libraryId:library.id }, create: { libraryId:library.id }, update: {} });
      const existing = await tx.inspirationLibraryTask.findFirst({ where: { inspirationLibraryId: library!.id, kind: 'INSPIRATION_SYNC', status: { in: ['PENDING', 'RUNNING'] }, expiresAt: { gt: new Date() } } });
      // A click also confirms a queued task from an older automatic worker.
      // Keep its identity instead of creating a second importer.
      if(existing){
        // A running importer keeps the actor/brand whose authority it validates.
        // The queue's original workspace identity is immutable. The confirmed
        // consumer context is independently pinned with the actor in inputJson.
        if(existing.status==='PENDING') {
          // Reconfirm the actor without resetting an in-progress fixed snapshot
          // or its overall deadline. A racing chunk must keep its newer state.
          const previous=existing.inputJson&&typeof existing.inputJson==='object'&&!Array.isArray(existing.inputJson)?existing.inputJson:{};
          await tx.inspirationLibraryTask.updateMany({where:{id:existing.id,status:'PENDING',updatedAt:existing.updatedAt},data:{inputJson:{...previous,trigger:'manual',userId:user.id,workspaceId:wsId}}});
        }
        return existing;
      }
      return tx.inspirationLibraryTask.create({ data: {workspaceId:wsId,inspirationLibraryId:library.id,kind:'INSPIRATION_SYNC', expiresAt: new Date(Date.now() + 6 * 60000), inputJson: { trigger: 'manual', userId: user.id,workspaceId:wsId } } });
    });
    return ok({ id: task.id, status: task.status }, { status: 202 });
  } catch (error) { return handleError(error); }
}
