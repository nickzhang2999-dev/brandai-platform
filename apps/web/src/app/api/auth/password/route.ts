import { z } from "zod";
import { prisma } from "@brandai/db";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { hashPassword, verifyPassword } from "@/lib/password";

/**
 * M-B · PATCH /api/auth/password — change/set the signed-in user's password.
 * `currentPassword` is required only when one is already set (so a demo/OAuth
 * user can set an initial password). Static route, wins over [...nextauth].
 */
const ChangePasswordInput = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "密码至少 8 位"),
});

export async function PATCH(req: Request) {
  try {
    const sessionUser = await requireUser();
    const input = parse(ChangePasswordInput, await req.json());

    const user = await prisma.user.findUnique({
      where: { id: sessionUser.id },
    });
    if (!user) throw new ApiException(404, "User not found");

    if (user.passwordHash) {
      if (
        !input.currentPassword ||
        !(await verifyPassword(input.currentPassword, user.passwordHash))
      ) {
        throw new ApiException(403, "当前密码不正确");
      }
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
