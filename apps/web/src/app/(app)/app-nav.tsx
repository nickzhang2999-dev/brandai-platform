"use client";

import { usePathname } from "next/navigation";
import { AppShell, type NavItem, Button } from "@brandai/ui";
import { OfflineBanner } from "./offline-banner";
import { QueueWidget } from "./queue-widget";

/**
 * Workspace-scoped nav. Computed on the client from usePathname() — the prior
 * server approach (reading a middleware-injected x-pathname header) was fragile
 * and silently fell back to the minimal nav in deployment, hiding the whole
 * workspace menu (资产库 / 图片生成 / …).
 */
function buildNav(pathname: string, isAdmin: boolean): NavItem[] {
  const adminItem: NavItem[] = isAdmin
    ? [
        {
          href: "/admin/users",
          label: "⚙ 用户管理",
          active: pathname.startsWith("/admin/users"),
        },
        {
          href: "/admin/plans",
          label: "⚙ 订阅额度",
          active: pathname.startsWith("/admin/plans"),
        },
        {
          href: "/admin/workspaces",
          label: "⚙ 全部空间",
          active: pathname.startsWith("/admin/workspaces"),
        },
        {
          href: "/admin/usage",
          label: "⚙ 用量看板",
          active: pathname.startsWith("/admin/usage"),
        },
        {
          href: "/admin/activity",
          label: "⚙ 运行日志",
          active: pathname.startsWith("/admin/activity"),
        },
        {
          href: "/admin/settings",
          label: "⚙ 平台设置",
          active: pathname.startsWith("/admin/settings"),
        },
      ]
    : [];
  const accountItem: NavItem = {
    href: "/account",
    label: "账号设置",
    active: pathname.startsWith("/account"),
  };
  const match = pathname.match(/^\/workspaces\/([^/]+)/);
  const wsId = match?.[1];

  if (!wsId) {
    return [
      { href: "/workspaces", label: "品牌空间", active: pathname === "/workspaces" },
      ...adminItem,
      accountItem,
    ];
  }

  const base = `/workspaces/${wsId}`;
  const items: { href: string; label: string }[] = [
    { href: base, label: "概览 Dashboard" },
    { href: `${base}/assets`, label: "资产库" },
    { href: `${base}/rules`, label: "风格规则" },
    { href: `${base}/generate`, label: "图片生成" },
    { href: `${base}/compliance`, label: "合规词库" },
    { href: `${base}/projects`, label: "项目与版本" },
  ];

  return [
    { href: "/workspaces", label: "← 全部品牌空间" },
    ...items.map((it) => ({
      ...it,
      active:
        it.href === base
          ? pathname === base
          : pathname === it.href || pathname.startsWith(`${it.href}/`),
    })),
    ...adminItem,
    accountItem,
  ];
}

export function AppNav({
  brandName,
  isAdmin,
  signOutAction,
  children,
}: {
  brandName: string;
  isAdmin: boolean;
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/workspaces";
  const nav = buildNav(pathname, isAdmin);
  // §2.3 — workspace-scoped queue widget. wsId is derived from the URL the
  // same way buildNav does (so they never disagree); off-workspace pages get
  // null → the widget renders nothing.
  const wsId = pathname.match(/^\/workspaces\/([^/]+)/)?.[1] ?? null;

  return (
    <AppShell
      brandName={brandName}
      nav={nav}
      headerRight={
        <form action={signOutAction}>
          <Button variant="ghost" size="sm">
            退出
          </Button>
        </form>
      }
    >
      <OfflineBanner />
      {children}
      <QueueWidget wsId={wsId} />
    </AppShell>
  );
}
