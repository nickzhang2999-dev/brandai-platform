import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { prisma } from "@brandai/db";
import { auth } from "@/auth";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new ApiException(401, "Unauthorized");
  }
  // 实时校验账号是否被管理员停用：JWT 是无状态的，停用后已签发的 token 仍能解出
  // 有效会话，故必须在 API 网关处查 DB，否则被停用用户可绕过 UI 直接调接口
  // 直到 token 过期。这是所有 BFF 路由的统一鉴权入口。
  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isActive: true },
  });
  if (!u || u.isActive === false) {
    throw new ApiException(403, "账号已被停用");
  }
  return session.user;
}

export class ApiException extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function handleError(err: unknown) {
  if (err instanceof ApiException) {
    return NextResponse.json(
      { error: err.message, details: err.details },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "ValidationError", details: err.flatten() },
      { status: 422 },
    );
  }
  console.error(err);
  return NextResponse.json(
    { error: "InternalError", details: String(err) },
    { status: 500 },
  );
}
