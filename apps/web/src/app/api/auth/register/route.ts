import { z } from "zod";
import { prisma } from "@brandai/db";
import { ApiException, handleError, ok, parse } from "@/lib/api";
import { adminEmails } from "@/lib/admin";
import { hashPassword } from "@/lib/password";
import { isRegistrationOpen } from "@/lib/settings";

/**
 * M-B · POST /api/auth/register — email/password sign-up. Creates a user with
 * a scrypt password hash (or attaches a password to an existing passwordless
 * demo/OAuth user). Does not start a session; the client then signs in via the
 * "password" provider. Static route, so it wins over the [...nextauth] catch-all.
 */
const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(8, "密码至少 8 位"),
  name: z.string().trim().min(1).optional(),
});

export async function POST(req: Request) {
  try {
    const input = parse(RegisterInput, await req.json());
    const email = input.email.trim().toLowerCase();

    // Registration gate. Default CLOSED — a platform admin opens it from
    // /admin/users. Two always-allowed exceptions so an operator is never
    // locked out of a fresh deploy: (1) emails on the ADMIN_EMAILS allowlist;
    // (2) the very first account when no admin exists yet (bootstrap).
    const onAllowlist = adminEmails().includes(email);
    const noAdminYet =
      adminEmails().length === 0 &&
      (await prisma.user.count({ where: { isAdmin: true } })) === 0;
    if (!onAllowlist && !noAdminYet && !(await isRegistrationOpen())) {
      throw new ApiException(403, "注册暂未开放,请联系管理员");
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    // 账号接管防护:拒绝任何**已存在**的用户行,而不仅是已设密码的。否则未鉴权的
    // 注册路径可把攻击者选的密码写到一个无 passwordHash 的 OAuth/demo 账号上,
    // 之后用该密码登录受害者账号。给已存在账号补密码必须经已鉴权会话/邮箱验证
    // (本平台无 OAuth/demo,直接拒绝最稳)。
    if (existing) {
      throw new ApiException(409, "该邮箱已注册");
    }

    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: input.name ?? email.split("@")[0],
      },
    });

    // Bootstrap: the first user to register becomes the platform admin, unless
    // an ADMIN_EMAILS allowlist is configured (then env is authoritative).
    if (!user.isAdmin && adminEmails().length === 0) {
      const adminCount = await prisma.user.count({ where: { isAdmin: true } });
      if (adminCount === 0) {
        await prisma.user.update({
          where: { id: user.id },
          data: { isAdmin: true },
        });
      }
    }

    return ok({ id: user.id, email: user.email }, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
