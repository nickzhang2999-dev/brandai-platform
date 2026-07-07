"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Admin section tabs. The admin console is split across sibling routes; this
 * horizontal tab bar (sticky, under the admin top bar) lets an operator move
 * between sections without scrolling a single long page. Active section is
 * derived from the current pathname so deep links / refresh highlight correctly.
 */
const TABS: { href: string; label: string }[] = [
  { href: "/admin/settings", label: "平台设置" },
  { href: "/admin/users", label: "用户管理" },
  { href: "/admin/plans", label: "订阅额度" },
  { href: "/admin/workspaces", label: "全部空间" },
  { href: "/admin/usage", label: "用量看板" },
  { href: "/admin/activity", label: "运行日志" },
];

export function AdminTabs() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="管理后台导航"
      className="flex gap-1 overflow-x-auto px-4 md:px-8"
    >
      {TABS.map((tab) => {
        const active =
          pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={[
              "shrink-0 whitespace-nowrap border-b-2 px-3 py-3 text-sm transition-colors",
              active
                ? "border-primary font-medium text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
