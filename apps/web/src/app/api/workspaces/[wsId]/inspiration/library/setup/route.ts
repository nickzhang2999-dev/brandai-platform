import { InspirationLibraryCreateResult } from '@brandai/contracts';
import { ApiException, handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { requireEnabled } from '@/lib/inspiration/service';
import { initializeSharedLibrary, ownerSharedLibrarySetup } from '@/lib/inspiration/library-setup';

/** Only the deployment-selected company owner may prepare the configured library. */
export async function POST(request: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser(), { wsId } = await params;
    const { workspace } = await requireWorkspaceRole(wsId, user.id, 'OWNER');
    // An OWNER membership does not transfer the workspace's billing/tenant ownership.
    if (workspace.ownerId !== user.id) throw new ApiException(403, '只有品牌实际所有者可以初始化公司灵感库。');
    requireEnabled();
    const configured = ownerSharedLibrarySetup(user.id);
    let body: unknown;
    try { body = await request.json(); } catch { throw new ApiException(400, '初始化请求必须为空 JSON 对象。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
      throw new ApiException(422, '初始化请求不接受所有者、库标识或其他自定义字段。');
    }
    const result = await initializeSharedLibrary({ ...configured, workspaceId: wsId }, { ownerSelfSetup: true });
    return ok(InspirationLibraryCreateResult.parse(result), { status: result.created ? 201 : 200 });
  } catch (error) { return handleError(error); }
}
