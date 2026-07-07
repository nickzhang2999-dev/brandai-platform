import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import {
  listAllWorkspaces,
  listAllWorks,
} from "@/lib/admin-workspaces";
import { AdminWorkspacesView } from "./admin-workspaces-view";

/**
 * Admin-only — read-only directory of EVERY brand workspace across all owners
 * (目录 tab) + a "作品广场" gallery of every GenerationVersion across the
 * platform sorted newest-first (gallery tab, P3+ addition). Non-admins are
 * bounced to /workspaces.
 */
export default async function AdminWorkspacesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/workspaces");
  }

  const [workspaces, works] = await Promise.all([
    listAllWorkspaces(),
    listAllWorks(60),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        ADMIN · 全部品牌空间
      </div>
      <h1 className="font-serif text-3xl text-foreground">所有空间(只读)</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        平台上所有用户的品牌空间总览 + 作品广场。点击空间名进入只读详情;点击作品图查看大图与受控规则。此处仅供查看,不能修改他人内容。
      </p>

      <AdminWorkspacesView workspaces={workspaces} works={works} />
    </div>
  );
}
