import { prisma } from "@brandai/db";
import { ChangePasswordInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { hashPassword, verifyPassword } from "@/lib/password";

/**
 * M-B · POST /api/me/password — change own password. Verifies `currentPassword`
 * against the stored scrypt hash before writing the new one. OAuth-only users
 * (no passwordHash) are told to use their provider instead of being able to set
 * a password without proving identity.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const input = parse(ChangePasswordInput, await req.json());

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!row?.passwordHash) {
      throw new ApiException(
        400,
        "当前账号未设置密码(通过第三方登录),无法修改密码",
      );
    }
    if (!(await verifyPassword(input.currentPassword, row.passwordHash))) {
      throw new ApiException(400, "当前密码不正确");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.newPassword) },
    });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
