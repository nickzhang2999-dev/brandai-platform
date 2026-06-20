import { prisma } from "@brandai/db";
import { ApiException, requireUser } from "@/lib/api";

/**
 * Platform-admin gate for /admin/settings (the platform AI key lives there, so
 * it must be locked to operators rather than any registered user).
 *
 * Two modes:
 * - ADMIN_EMAILS set (comma-separated) → that allowlist is authoritative. This
 *   is the "change the admin via env" escape hatch.
 * - ADMIN_EMAILS unset → the first user to register is admin (User.isAdmin,
 *   bootstrapped in the register route). Zero-config for a fresh deploy.
 */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function isAdminUser(
  userId: string,
  email?: string | null,
): Promise<boolean> {
  const allow = adminEmails();
  if (allow.length > 0) {
    return !!email && allow.includes(email.trim().toLowerCase());
  }
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  });
  return !!u?.isAdmin;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (!(await isAdminUser(user.id, user.email))) {
    throw new ApiException(403, "Admin access required");
  }
  return user;
}
