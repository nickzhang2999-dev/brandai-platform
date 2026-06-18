import { notFound } from "next/navigation";
import { EditorialHeader } from "@brandai/ui";
import { auth } from "@/auth";
import { getWorkspaceRole } from "@/lib/workspace";
import { listMembers } from "@/lib/members";
import { MembersPanel } from "./members-panel";

export const dynamic = "force-dynamic";

/**
 * G6 · 团队成员 — workspace collaboration. Any member can view; only the OWNER
 * can invite (by email) / change roles / remove. Roles: OWNER>EDITOR>REVIEWER>
 * VIEWER (EDITOR 送审, REVIEWER 审批).
 */
export default async function MembersPage({
  params,
}: {
  params: Promise<{ wsId: string }>;
}) {
  const { wsId } = await params;
  const session = await auth();
  const userId = session!.user!.id;
  const role = await getWorkspaceRole(wsId, userId);
  if (!role) notFound();

  const members = await listMembers(wsId);

  return (
    <div className="mx-auto max-w-4xl">
      <EditorialHeader
        eyebrow="TEAM · 团队协作"
        title="团队成员"
        subtitle="邀请协作者共用此品牌空间。角色:所有者 / 编辑(可送审)/ 审核(可批准驳回)/ 查看。被邀请人需先注册账号。"
      />
      <MembersPanel
        wsId={wsId}
        initialMembers={members}
        myRole={role}
        currentUserId={userId}
      />
    </div>
  );
}
