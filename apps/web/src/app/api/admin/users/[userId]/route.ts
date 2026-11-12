import { prisma } from "@brandai/db";
import { AdminUpdateUserInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { listAdminUsers } from "@/lib/admin-users";

import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    if (userId === admin.id) {
      throw new ApiException(400, "不能停用或启用自己的账号");
    }
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "请求来源无效");
    const input = parse(AdminUpdateUserInput, await req.json());
    const updated = await prisma.user.updateMany({
      where: { id: userId, isActive: !input.isActive },
      data: {
        isActive: input.isActive,
        ...(!input.isActive && { sessionVersion: { increment: 1 } }),
      },
    });
    if (!updated.count && !(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
      throw new ApiException(404, "账号不存在");
    }
    // Return the refreshed list so the client re-renders from the server truth.
    return ok({ users: await listAdminUsers() });
  } catch (err) {
    return handleError(err);
  }
}
