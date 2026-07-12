import { prisma } from "@brandai/db";
import { UpdateProfileInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";

/**
 * V0.0.12 · PATCH /api/me/profile — update the caller's display nickname.
 * The value is account-scoped, not brand-scoped; BrandAI layout reads the DB
 * value on refresh so homepage greetings and the sidebar stay consistent.
 */
export async function PATCH(req: Request) {
  try {
    const user = await requireUser();
    const input = parse(UpdateProfileInput, await req.json());
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { name: input.name },
      select: { email: true, name: true },
    });
    return ok({
      email: updated.email,
      name: updated.name ?? updated.email.split("@")[0],
    });
  } catch (err) {
    return handleError(err);
  }
}
