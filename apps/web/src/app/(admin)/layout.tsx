import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@brandai/db";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { AdminTabs } from "./admin/admin-tabs";

/**
 * Admin console shell — its own route group so it does NOT inherit the product
 * (brandai) sidebar or the legacy (app) shell. Gives the platform admin a
 * dedicated, tabbed console instead of a stack of long, scroll-heavy pages.
 *
 * Guards (defense-in-depth; each admin page + every /api/admin route also
 * re-checks): unauthenticated → /login; disabled account → /login; non-admin
 * → / (home). The AI platform key lives behind these routes, so the gate is
 * intentionally strict.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // JWTs are stateless, so a disabled account keeps a valid token until expiry.
  // Re-check DB before rendering the admin shell (mirrors (app)/(brandai)).
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isActive: true },
  });
  if (!dbUser || dbUser.isActive === false) redirect("/login");

  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="flex h-16 items-center gap-4 px-4 md:px-8">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <span aria-hidden>←</span>
            返回首页
          </Link>
          <div className="min-w-0">
            <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
              ADMIN
            </div>
            <div className="truncate font-serif text-lg leading-tight text-foreground">
              管理后台
            </div>
          </div>
          <div className="ml-auto hidden truncate text-xs text-muted-foreground sm:block">
            {session.user.email}
          </div>
        </div>
        <AdminTabs />
      </header>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
