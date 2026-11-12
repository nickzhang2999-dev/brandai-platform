import { AdminCreateUserInput } from "@brandai/contracts";
import { prisma, Prisma } from "@brandai/db";
import { hashPassword } from "@/lib/password";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { ApiException, handleError, ok, parse } from "@/lib/api";
import { adminEmails, requireAdmin } from "@/lib/admin";
import { listAdminUsers } from "@/lib/admin-users";

/**
 * Admin-only — list every registered user with brand-space count + effective
 * subscription quota. Gated by ADMIN_EMAILS (or the bootstrap admin) via
 * requireAdmin.
 */
export async function GET() {
  try {
    await requireAdmin();
    return ok({ users: await listAdminUsers() });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "请求来源无效");
    const input = parse(AdminCreateUserInput, await req.json());
    const existing = await prisma.user.findFirst({
      where: { email: { equals: input.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (existing || adminEmails().includes(input.email)) {
      throw new ApiException(409, "这个邮箱已用于其他账号或保留给现有管理员");
    }
    await prisma.user.create({
      data: { name: input.name, email: input.email, passwordHash: await hashPassword(input.password) },
      select: { id: true },
    });
    return ok({ users: await listAdminUsers() }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return handleError(new ApiException(409, "这个邮箱已用于其他账号"));
    }
    return handleError(err);
  }
}
