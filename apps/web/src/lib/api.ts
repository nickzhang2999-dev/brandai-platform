import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { auth } from "@/auth";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new ApiException(401, "Unauthorized");
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
