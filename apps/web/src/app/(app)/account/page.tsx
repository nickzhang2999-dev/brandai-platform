import { redirect } from "next/navigation";
import { prisma } from "@brandai/db";
import { CreamCard } from "@brandai/ui";
import { auth } from "@/auth";
import { AccountNavActions } from "./AccountNavActions";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { ThemeSwitcher } from "./ThemeSwitcher";

/**
 * Self-service account page. Currently: change own password. OAuth-only users
 * (no passwordHash) see an explanation instead of the form, since there is no
 * current password to verify against.
 */
export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, name: true, passwordHash: true },
  });
  const hasPassword = !!user?.passwordHash;

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        ACCOUNT · 账号设置
      </div>
      <h1 className="font-serif text-3xl text-foreground">账号设置</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {user?.email}
        {user?.name ? ` · ${user.name}` : ""}
      </p>
      <AccountNavActions />

      <section className="mt-8">
        <h2 className="font-serif text-xl text-foreground">界面外观</h2>
        <div className="mt-3">
          <ThemeSwitcher />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-xl text-foreground">修改密码</h2>
        {hasPassword ? (
          <div className="mt-3">
            <ChangePasswordForm />
          </div>
        ) : (
          <CreamCard className="mt-3 p-5 text-sm text-muted-foreground">
            当前账号通过第三方登录,未设置独立密码,无需在此修改。
          </CreamCard>
        )}
      </section>
    </div>
  );
}
