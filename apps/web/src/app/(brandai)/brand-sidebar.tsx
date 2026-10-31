"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { FileImage, Folder, Home, Image as ImageIcon, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Users, Shapes } from "lucide-react";
import type { BrandWorkspace } from "@brandai/contracts";
import { navItems } from "@/lib/brandai-nav";
import { studioEditorHref } from "@/lib/studio-navigation";
import { NotificationCenter } from "./notification-center";
import { useBrand } from "./brand-context";
import { DeleteBrandDialog } from "./brand-delete-dialog";

const icons = { home: Home, campaigns: Folder, "brand-knowledge": FileImage, assets: ImageIcon, inspiration: Sparkles, workspace: Sparkles, generated: ImageIcon, templates: Shapes, members: Users };

/** One DeepFlare shell across projects, knowledge and assets. The narrow rail
 * keeps accessible labels while desktop uses the reviewed round navigation. */
export function BrandSidebar({ children, user, isAdmin }: {
  children: React.ReactNode; user: { name: string; email: string; initial: string }; isAdmin: boolean;
}) {
  const pathname = usePathname() ?? "/studio";
  const { brandName, brands, createBrand, deleteBrand, switchBrand, updateBrand, user: brandUser, wsId } = useBrand();
  const [creatingBrand, setCreatingBrand] = useState(false);
  const [renamingBrand, setRenamingBrand] = useState<BrandWorkspace | null>(null);
  const [deletingBrand, setDeletingBrand] = useState<BrandWorkspace | null>(null);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeBrand = brands.find(brand => brand.id === wsId);
  const canManage = activeBrand?.ownerId === brandUser.id;
  const scoped = (href: string) => href === "/studio#/projects" ? studioEditorHref({ workspaceId: wsId })
    : href + "?" + new URLSearchParams({ workspaceId: wsId });

  useEffect(() => {
    if (!brandMenuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setBrandMenuOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setBrandMenuOpen(false); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [brandMenuOpen]);

  return <div className="flex min-h-screen bg-background text-foreground">
    <aside aria-label="DeepFlare 导航" className="sticky top-0 flex h-dvh w-[76px] shrink-0 flex-col border-r border-border bg-card px-2 py-5 sm:w-[220px] sm:px-4 sm:py-6">
      <Link href={scoped("/studio")} aria-label="DeepFlare 首页" className="mb-7 flex h-12 shrink-0 items-center justify-center sm:justify-start sm:px-2">
        <img src="/brand/deepflare-mark.svg" alt="" className="h-10 w-10 object-contain sm:hidden" />
        <img src="/brand/deepflare-logo.svg" alt="DeepFlare · 曜影深蓝" className="hidden h-12 w-[156px] object-contain object-left sm:block dark:sm:hidden" />
        <img src="/brand/deepflare-logo-dark.svg" alt="DeepFlare · 曜影深蓝" className="hidden h-12 w-[156px] object-contain object-left dark:sm:block" />
      </Link>
      <div ref={menuRef} className="relative mb-5">
        <button type="button" aria-label="品牌菜单" aria-haspopup="menu" aria-expanded={brandMenuOpen} onClick={() => setBrandMenuOpen(value => !value)}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-border px-2 text-sm transition-colors hover:bg-accent-soft sm:justify-between sm:px-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-primary">{brandName.slice(0, 1)}</span>
          <span className="hidden min-w-0 flex-1 truncate text-left sm:block">{brandName}</span><MoreHorizontal className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
        </button>
        {brandMenuOpen && <div role="menu" aria-label="品牌管理" className="absolute left-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-24px)] rounded-2xl border border-border bg-card p-2 shadow-lg">
          <p className="px-3 py-2 text-xs text-muted-foreground">切换品牌</p>
          <div className="max-h-[35vh] overflow-y-auto">{brands.map(brand => <button key={brand.id} type="button" role="menuitemradio" aria-checked={brand.id === wsId}
            className={"flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm " + (brand.id === wsId ? "bg-accent-soft text-primary" : "hover:bg-muted")}
            onClick={() => { setBrandMenuOpen(false); if (brand.id !== wsId) switchBrand(brand.id); }}><span className="min-w-0 flex-1 truncate">{brand.name}</span>{brand.id === wsId && <span aria-hidden="true">✓</span>}</button>)}</div>
          <div className="mt-2 border-t border-border pt-2">
            <button type="button" role="menuitem" onClick={() => { setBrandMenuOpen(false); setCreatingBrand(true); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-muted"><Plus className="h-4 w-4" />创建品牌套件</button>
            <Link href={scoped("/members")} role="menuitem" onClick={() => setBrandMenuOpen(false)} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-muted"><Users className="h-4 w-4" />成员协作</Link>
            {canManage && activeBrand && <>
              <button type="button" role="menuitem" onClick={() => { setBrandMenuOpen(false); setRenamingBrand(activeBrand); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-muted"><Pencil className="h-4 w-4" />品牌改名</button>
              <button type="button" role="menuitem" onClick={() => { setBrandMenuOpen(false); setDeletingBrand(activeBrand); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" />删除品牌套件</button>
            </>}
          </div>
        </div>}
      </div>
      <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {navItems.filter(item => !item.hidden).map(item => {
          const Icon = icons[item.key]; const active = item.key === "home" ? pathname === "/studio" : item.key === "workspace" ? pathname.startsWith("/studio-editor") : pathname.startsWith(item.href);
          return <Link key={item.key} href={scoped(item.href)} aria-label={item.label} title={item.label} aria-current={active ? "page" : undefined}
            className={"flex h-11 shrink-0 items-center justify-center gap-3 rounded-full px-3 text-sm transition-colors sm:justify-start " + (active ? "bg-accent-soft font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            <Icon className="h-[18px] w-[18px] shrink-0" /><span className="hidden truncate sm:block">{item.label}</span>
          </Link>;
        })}
      </nav>
      <div className="mt-5 shrink-0 border-t border-border pt-4"><UserMenu user={user} brandName={brandName} isAdmin={isAdmin} workspaceId={wsId} /></div>
    </aside>
    <main className="min-w-0 flex-1">{children}</main>
    <div className="fixed right-4 top-4 z-40"><NotificationCenter wsId={wsId} userId={brandUser.id} /></div>
    {creatingBrand && <CreateBrandDialog creating={false} onClose={() => setCreatingBrand(false)} onCreate={async input => { await createBrand(input); setCreatingBrand(false); }} />}
    {renamingBrand && <RenameBrandDialog brand={renamingBrand} onClose={() => setRenamingBrand(null)} onRename={async name => { await updateBrand(renamingBrand.id, { name }); setRenamingBrand(null); }} />}
    {deletingBrand && <DeleteBrandDialog key={brandUser.id + ":" + deletingBrand.id} brand={deletingBrand} userId={brandUser.id} onClose={() => setDeletingBrand(null)} onDelete={input => deleteBrand(deletingBrand.id, input)} />}
  </div>;
}

function CreateBrandDialog({
  creating,
  onClose,
  onCreate,
}: {
  creating: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; industry?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = creating || saving;

  async function submit() {
    if (!name.trim() || busy) return;
    setError(null);
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        industry: industry.trim() || undefined,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "创建品牌失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="创建品牌套件" className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_70px_rgba(30,30,60,0.22)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">创建品牌套件</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            创建后，可在该品牌套件下创建多个项目，并进入对应工作台。
          </p>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">品牌套件名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：耐克、阿迪、李宁"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/40"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">所属行业</span>
            <input
              value={industry}
              onChange={(event) => setIndustry(event.target.value)}
              placeholder="例如：运动服饰"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary/40"
            />
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
          {error && <p role="alert" className="w-full break-words text-sm text-destructive">{error}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-60"
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameBrandDialog({
  brand,
  onClose,
  onRename,
}: {
  brand: BrandWorkspace;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(brand.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || saving) return;
    setError(null);
    setSaving(true);
    try {
      await onRename(name.trim());
    } catch (error) {
      setError(error instanceof Error ? error.message : "品牌改名失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="品牌套件改名"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-sm"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_70px_rgba(30,30,60,0.22)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">品牌套件改名</h2>
        </div>
        <div className="px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">新名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/15"
            />
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
          {error && <p role="alert" className="w-full break-words text-sm text-destructive">{error}</p>}
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="h-10 rounded-xl border border-border px-4 text-sm text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!name.trim() || saving}
            onClick={() => void submit()}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A2 · 用户信息区 + 个人菜单 — clicking the user card opens a popover with the
 * real account email and actions: 设置(管理后台) + 退出登录. Logout uses the
 * client-side Auth.js `signOut` (next-auth/react), the same module the login
 * page uses for `signIn`; it clears the session and returns to `/studio`.
 */
function UserMenu({
  user,
  brandName,
  isAdmin,
  workspaceId,
}: {
  user: { name: string; email: string; initial: string };
  brandName: string;
  isAdmin: boolean;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-away + Escape close (matches notification-center idiom).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="账号菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        className={[
          "flex w-full items-center justify-center gap-3 rounded-2xl px-2 py-3 text-left transition-colors sm:justify-start",
          open ? "bg-accent-soft" : "bg-muted hover:bg-accent-soft/60",
        ].join(" ")}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-sm font-semibold text-primary-foreground">
          {user.initial}
        </span>
        <div className="hidden min-w-0 flex-1 sm:block">
          <div className="truncate text-sm font-medium">{user.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {brandName}
          </div>
        </div>
        <span
          className={[
            "hidden shrink-0 text-xs text-muted-foreground transition-transform sm:block",
            open ? "rotate-180" : "",
          ].join(" ")}
        >
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-full min-w-[220px] overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_70px_rgba(124,92,255,0.18)]"
        >
          <div className="border-b border-border px-4 py-3">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {user.email}
            </div>
          </div>
          <div className="flex flex-col py-1">
            <Link
              href={"/account?" + new URLSearchParams({ workspaceId })}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground/90 transition-colors hover:bg-muted"
            >
              <span className="w-4 text-center text-base">⚙</span>
              账号设置
            </Link>
            {isAdmin ? (
              <Link
                href="/admin"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground/90 transition-colors hover:bg-muted"
              >
                <span className="w-4 text-center text-base">🛡</span>
                管理后台
              </Link>
            ) : null}
            <button
              type="button"
              role="menuitem"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut({ callbackUrl: "/studio" });
              }}
              className="flex items-center gap-2.5 px-4 py-2.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
            >
              <span className="w-4 text-center text-base">⏻</span>
              {signingOut ? "退出中…" : "退出登录"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
