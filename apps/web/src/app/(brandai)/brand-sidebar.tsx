"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/brandai-mock";
import { QueueWidget } from "@/app/(app)/queue-widget";
import { NotificationCenter } from "./notification-center";

/**
 * BrandAI 左侧导航壳（docs/04 §布局：侧栏 236px，logo mark + 主导航 + 底部
 * 用户卡）。紫色设计语言：选中项用 lavender 底 + violet 文字。品牌名/用户来自
 * 真实会话（由 (brandai)/layout 注入）。
 */
export function BrandSidebar({
  children,
  brandName,
  user,
  wsId,
}: {
  children: React.ReactNode;
  brandName: string;
  user: { name: string; email: string; initial: string };
  wsId: string;
}) {
  const pathname = usePathname() ?? "/";

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="sticky top-0 flex h-screen w-[236px] shrink-0 flex-col border-r border-border bg-card px-4 py-6">
        {/* Logo */}
        <Link href="/" className="mb-8 flex items-center gap-3 px-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-accent text-base font-semibold text-primary-foreground shadow-[0_10px_24px_rgba(124,92,255,0.25)]">
            B
          </span>
          <span className="text-lg font-semibold tracking-tight">BrandAI</span>
        </Link>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-1.5">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={[
                  "flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-accent-soft font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                ].join(" ")}
              >
                <span className="w-5 text-center text-base">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Settings + user */}
        <div className="mt-4 flex flex-col gap-2">
          <Link
            href="/admin/settings"
            className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span className="w-5 text-center text-base">⚙</span>
            设置
          </Link>
          <div className="flex items-center gap-3 rounded-2xl bg-muted px-3 py-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-sm font-semibold text-primary-foreground">
              {user.initial}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{user.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {brandName}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>

      {/* A3 / L3 — top-bar notification entry (bell + inbox). Fixed top-right so
          it sits consistently over every product page, including the
          full-height workspace, without shifting page layout. */}
      <div className="fixed right-4 top-4 z-40">
        <NotificationCenter wsId={wsId} />
      </div>

      {/* §2.3 — persistent cross-page queue widget (bottom-right). Reused from
          the (app) shell so BrandAI pages get the same observable surface. */}
      <QueueWidget wsId={wsId} />
    </div>
  );
}
