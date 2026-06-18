import { prisma } from "@brandai/db";
import { AdminUpdateUserInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { listAdminUsers } from "@/lib/admin-users";

/**
 * Admin-only — enable/disable (PATCH) or delete (DELETE) a user account.
 *
 * Self-protection: an admin can neither disable nor delete their own account
 * (a one-click platform lockout). All other targets are allowed; a disabled
 * user can no longer sign in (auth.ts) and is bounced from the app shell.
 */

async function loadTarget(userId: string) {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!target) throw new ApiException(404, "User not found");
  return target;
}

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
    await loadTarget(userId);
    const input = parse(AdminUpdateUserInput, await req.json());
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: input.isActive },
    });
    // Return the refreshed list so the client re-renders from the server truth.
    return ok({ users: await listAdminUsers() });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    if (userId === admin.id) {
      throw new ApiException(400, "不能删除自己的账号");
    }
    await loadTarget(userId);
    // Cascades to the user's workspaces (and their assets/rules/projects/…)
    // and subscription via onDelete: Cascade in the schema.
    await prisma.user.delete({ where: { id: userId } });
    return ok({ users: await listAdminUsers() });
  } catch (err) {
    return handleError(err);
  }
}
