import { prisma } from "@brandai/db";
import { InviteMemberInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { listMembers } from "@/lib/members";

/**
 * G6 · GET → list workspace members (+ caller's own role). Any member (VIEWER+).
 *      POST → invite an already-registered user by email (OWNER only).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    const { role } = await requireWorkspaceRole(wsId, user.id, "VIEWER");
    return ok({ members: await listMembers(wsId), myRole: role });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    const { workspace } = await requireWorkspaceRole(wsId, user.id, "OWNER");
    const input = parse(InviteMemberInput, await req.json());

    const invitee = await prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
      select: { id: true },
    });
    if (!invitee) {
      throw new ApiException(404, "该邮箱尚未注册,无法邀请(对方需先注册账号)");
    }
    if (invitee.id === workspace.ownerId) {
      throw new ApiException(400, "该用户是空间所有者,无需邀请");
    }
    // Idempotent: re-inviting updates the role.
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: invitee.id, workspaceId: wsId } },
      update: { role: input.role },
      create: { userId: invitee.id, workspaceId: wsId, role: input.role },
    });
    return ok({ members: await listMembers(wsId), myRole: "OWNER" }, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
