import { redirect } from "next/navigation";
import { prisma } from "@brandai/db";
import { Button } from "@brandai/ui";
import { auth, signOut } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { AppNav } from "./app-nav";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  // Disabled accounts (admin user-management) are kicked from the whole app
  // shell, even with a still-valid JWT — sign-in is already blocked in auth.ts,
  // this covers existing sessions of every provider (including OAuth).
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isActive: true },
  });
  if (dbUser && dbUser.isActive === false) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
        <div className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          ACCOUNT DISABLED
        </div>
        <h1 className="font-serif text-3xl text-foreground">账号已被停用</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          你的账号已被平台管理员停用,暂时无法访问工作台。如有疑问请联系管理员。
        </p>
        <form action={doSignOut}>
          <Button variant="outline">退出登录</Button>
        </form>
      </main>
    );
  }

  const isAdmin = await isAdminUser(session.user.id, session.user.email);

  return (
    <AppNav
      brandName={session.user.email ?? "工作台"}
      isAdmin={isAdmin}
      signOutAction={doSignOut}
    >
      {children}
    </AppNav>
  );
}
