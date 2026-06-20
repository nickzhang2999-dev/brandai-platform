import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { listAdminUsers } from "@/lib/admin-users";
import { isRegistrationOpen } from "@/lib/settings";
import { UsersTable } from "./UsersTable";
import { RegistrationToggle } from "./RegistrationToggle";

/**
 * Platform user management (admin only). Lists registered users with their
 * brand-space count + subscription quota, and lets an operator enable / disable
 * / delete accounts. Gated to the platform admin — non-admins are bounced to
 * /workspaces (no leak that the page exists beyond the redirect).
 */
export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/workspaces");
  }

  const [users, registrationOpen] = await Promise.all([
    listAdminUsers(),
    isRegistrationOpen(),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        ADMIN · 用户管理
      </div>
      <h1 className="font-serif text-3xl text-foreground">注册用户</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        平台所有注册账号。可启用 / 禁用 / 删除。禁用后该账号无法登录、并被请出工作台;
        删除会连同其品牌空间、资产、规则与生成记录一并移除,不可恢复。
      </p>
      <div className="mt-8">
        <RegistrationToggle initialOpen={registrationOpen} />
      </div>
      <div className="mt-6">
        <UsersTable initial={users} currentUserId={session.user.id} />
      </div>
    </div>
  );
}
