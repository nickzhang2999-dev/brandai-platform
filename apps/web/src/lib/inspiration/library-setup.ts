import type { InspirationLibraryCreateInput } from '@brandai/contracts';
import { prisma } from '@brandai/db';
import { ApiException } from '../api';
import { sharedLibrarySetupId, sourceLibrary } from './library';

/** Deployment-selected owner only; no role promotion or client-selected tenant. */
export function ownerSharedLibrarySetup(userId: string) {
  const ownerId = process.env.INSPIRATION_SHARED_SETUP_OWNER_ID?.trim();
  if (!ownerId || ownerId.length > 128 || /\s/.test(ownerId)) {
    throw new ApiException(503, '公司灵感库自助初始化尚未配置。');
  }
  if (userId !== ownerId) throw new ApiException(403, '当前账号不能初始化指定的公司灵感库。');
  const libraryId = sharedLibrarySetupId();
  if (!libraryId) throw new ApiException(503, '公司灵感库初始化标识尚未配置。');
  return { ownerId, libraryId };
}

/** Caller authenticates either an administrator or the explicitly configured owner. */
export async function initializeSharedLibrary(input: InspirationLibraryCreateInput) {
  if (input.libraryId !== sharedLibrarySetupId()) throw new ApiException(409, '请先配置指定的公司灵感库。');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inspiration-library:${input.libraryId}`}))`;
    // Revalidate and pin ownership through commit, including concurrent transfers.
    if (input.workspaceId) {
      const brands = await tx.$queryRaw<Array<{ ownerId: string }>>`SELECT "ownerId" FROM "BrandWorkspace" WHERE "id"=${input.workspaceId} FOR SHARE`;
      if (brands[0]?.ownerId !== input.ownerId) throw new ApiException(409, '所选品牌归属已变化或品牌不可用，请刷新后重新确认。');
    }
    const identity = await tx.inspirationLibraryIdentity.findUnique({ where: { id: input.libraryId } });
    if (identity && identity.ownerId !== input.ownerId) throw new ApiException(409, '该库标识已绑定原所有者，不能重新分配。');
    const existing = await tx.inspirationLibrary.findUnique({ where: { id: input.libraryId } });
    if (existing && (existing.kind !== 'SHARED' || existing.ownerId !== input.ownerId)) throw new ApiException(409, '该库标识已属于其他范围，不能覆盖。');
    const owner = await tx.user.findUnique({ where: { id: input.ownerId }, select: { isActive: true } });
    if (!owner?.isActive) throw new ApiException(404, '指定的公司所有者不可用。');
    if (!identity) await tx.inspirationLibraryIdentity.create({ data: { id: input.libraryId, ownerId: input.ownerId } });
    if (existing) return { sourceLibrary: sourceLibrary(existing), created: false };
    const library = await tx.inspirationLibrary.create({ data: { id: input.libraryId, kind: 'SHARED', ownerId: input.ownerId } });
    return { sourceLibrary: sourceLibrary(library), created: true };
  });
}
