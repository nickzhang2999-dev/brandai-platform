import { prisma } from "@brandai/db";
import { UpdateMemberInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { listMembers } from "@/lib/members";

/**
 * G6 · PATCH → change a member's role (OWNER only).
 *      DELETE → remove a member (OWNER only).
 * The workspace owner's own membership can't be demoted or removed.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; userId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, userId } = await params;
    const { workspace } = await requireWorkspaceRole(wsId, user.id, "OWNER");
    if (userId === workspace.ownerId) {
      throw new ApiException(400, "不能修改空间所有者的角色");
    }
    const input = parse(UpdateMemberInput, await req.json());
    const existing = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: wsId } },
    });
    if (!existing) throw new ApiException(404, "成员不存在");
    await prisma.membership.update({
      where: { userId_workspaceId: { userId, workspaceId: wsId } },
      data: { role: input.role },
    });
    return ok({ members: await listMembers(wsId), myRole: "OWNER" });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; userId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, userId } = await params;
    const { workspace } = await requireWorkspaceRole(wsId, user.id, "OWNER");
    if (userId === workspace.ownerId) {
      throw new ApiException(400, "不能移除空间所有者");
    }
    await prisma.membership.deleteMany({
      where: { userId, workspaceId: wsId },
    });
    return ok({ members: await listMembers(wsId), myRole: "OWNER" });
  } catch (err) {
    return handleError(err);
  }
}
