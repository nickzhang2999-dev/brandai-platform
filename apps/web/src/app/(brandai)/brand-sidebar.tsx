"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  ArrowLeft,
  FileImage,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { BrandWorkspace } from "@brandai/contracts";
import { navItems } from "@/lib/brandai-mock";
import { NotificationCenter } from "./notification-center";
import { useBrand } from "./brand-context";

/**
 * BrandAI 左侧导航壳。常规产品页使用 236px 主导航；品牌套件路由切换为
 * 216px Lovart 式套件卡片栏，不混入账号区与大品牌 Logo。紫色设计语言：
 * 选中项用 lavender 底 + violet 文字。品牌名/用户来自真实会话。
 */
export function BrandSidebar({
  children,
  user,
  isAdmin,
}: {
  children: React.ReactNode;
  user: { name: string; email: string; initial: string };
  isAdmin: boolean;
}) {
  const pathname = usePathname() ?? "/";
  const {
    brandName,
    brands,
    createBrand,
    deleteBrand,
    switchBrand,
    updateBrand,
    user: brandUser,
    wsId,
  } = useBrand();
  const [creatingBrand, setCreatingBrand] = useState(false);
  const [brandMenuId, setBrandMenuId] = useState<string | null>(null);
  const [renamingBrand, setRenamingBrand] = useState<BrandWorkspace | null>(
    null,
  );
  const [deletingBrand, setDeletingBrand] = useState<BrandWorkspace | null>(
    null,
  );

  const isBrandKitPage = pathname.startsWith("/brand-knowledge");

  useEffect(() => {
    if (!brandMenuId) return;
    const close = () => setBrandMenuId(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [brandMenuId]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside
        className={[
          "sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-card",
          isBrandKitPage ? "w-[216px] px-3 py-4" : "w-[236px] px-4 py-6",
        ].join(" ")}
      >
        {/* Logo */}
        {!isBrandKitPage ? (
          <Link href="/" className="mb-7 flex items-center px-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/nova-art-lab-logo.png"
              alt="NOVA ART LAB"
              className="h-12 w-[156px] object-contain object-left"
            />
          </Link>
        ) : null}

        {isBrandKitPage ? (
          <>
            <div className="flex h-8 items-center justify-between px-1">
              <div className="flex items-center gap-1.5">
                <h1 className="text-sm font-semibold">我的品牌套件</h1>
                <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-medium text-primary">
                  Beta
                </span>
              </div>
              <Info className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <button
              type="button"
              onClick={() => setCreatingBrand(true)}
              className="mt-2 flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-background text-xs font-medium transition-colors duration-200 hover:border-primary/35 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <Plus className="h-4 w-4" />
              新建
            </button>
            <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {brands.map((brand) => {
                const active = brand.id === wsId;
                const canManage = brand.ownerId === brandUser.id;
                return (
                  <div
                    key={brand.id}
                    className={[
                      "group relative overflow-visible rounded-lg border p-1 transition-colors duration-200",
                      active
                        ? "border-primary/45 bg-accent-soft/45"
                        : "border-transparent hover:border-border hover:bg-muted/45",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        if (!active) switchBrand(brand.id);
                      }}
                      className="w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <span className="flex aspect-[16/9] w-full items-center justify-center overflow-hidden rounded-md bg-muted">
                        {brand.coverImage ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={brand.coverImage}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <FileImage className="h-7 w-7 text-muted-foreground/55" />
                        )}
                      </span>
                      <span className="mt-1.5 block truncate px-1 pr-8 text-[11px] font-medium">
                        {brand.name}
                      </span>
                    </button>
                    {canManage ? (
                      <button
                        type="button"
                        aria-label={`管理${brand.name}`}
                        aria-haspopup="menu"
                        aria-expanded={brandMenuId === brand.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setBrandMenuId((current) =>
                            current === brand.id ? null : brand.id,
                          );
                        }}
                        className="absolute bottom-1 right-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    ) : null}
                    {brandMenuId === brand.id ? (
                      <div
                        role="menu"
                        onClick={(event) => event.stopPropagation()}
                        className="absolute bottom-9 right-1 z-50 w-32 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-[0_16px_40px_rgba(30,30,60,0.16)]"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setRenamingBrand(brand);
                            setBrandMenuId(null);
                          }}
                          className="flex h-10 w-full cursor-pointer items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-muted"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          改名
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setDeletingBrand(brand);
                            setBrandMenuId(null);
                          }}
                          className="flex h-10 w-full cursor-pointer items-center gap-2 px-3 text-left text-xs text-destructive transition-colors hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <Link
              href="/"
              className="mt-3 flex h-9 items-center gap-2 rounded-lg px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              返回主导航
            </Link>
          </>
        ) : (
          <>
            <div className="mb-5 flex flex-col gap-3 border-b border-border pb-5">
              <label className="flex flex-col gap-1.5 px-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  当前品牌套件
                </span>
                <select
                  value={wsId}
                  onChange={(event) => switchBrand(event.target.value)}
                  aria-label="切换品牌"
                  className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-primary/40"
                >
                  {brands.length === 0 ? (
                    <option value={wsId}>请先创建品牌套件</option>
                  ) : (
                    brands.map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setCreatingBrand(true)}
                className="mx-1 flex h-9 items-center justify-center rounded-lg border border-primary/25 bg-accent-soft text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
              >
                ＋ 创建品牌套件
              </button>
            </div>

            <nav className="flex flex-1 flex-col gap-1.5">
              {navItems
                .filter((item) => !item.hidden)
                .map((item) => {
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
                      <span className="w-5 text-center text-base">
                        {item.icon}
                      </span>
                      {item.label}
                    </Link>
                  );
                })}
            </nav>
          </>
        )}

        {/* Settings + user */}
        <div
          className={[
            "mt-4 flex flex-col gap-2",
            isBrandKitPage ? "hidden" : "",
          ].join(" ")}
        >
          <Link
            href="/account"
            className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span className="w-5 text-center text-base">⚙</span>
            账号设置
          </Link>
          {/* A2 · 用户信息区 — avatar / name / position(email) + 个人菜单 */}
          <UserMenu user={user} brandName={brandName} isAdmin={isAdmin} />
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>

      {/* A3 / L3 — top-bar notification entry (bell + inbox). Fixed top-right so
          it sits consistently over every product page, including the
          full-height workspace, without shifting page layout. */}
      {!isBrandKitPage ? (
        <div className="fixed right-4 top-4 z-40">
          <NotificationCenter wsId={wsId} />
        </div>
      ) : null}

      {creatingBrand ? (
        <CreateBrandDialog
          creating={false}
          onClose={() => setCreatingBrand(false)}
          onCreate={async (input) => {
            await createBrand(input);
            setCreatingBrand(false);
          }}
        />
      ) : null}
      {renamingBrand ? (
        <RenameBrandDialog
          brand={renamingBrand}
          onClose={() => setRenamingBrand(null)}
          onRename={async (name) => {
            await updateBrand(renamingBrand.id, { name });
            setRenamingBrand(null);
          }}
        />
      ) : null}
      {deletingBrand ? (
        <DeleteBrandDialog
          brand={deletingBrand}
          onClose={() => setDeletingBrand(null)}
          onDelete={async () => {
            await deleteBrand(deletingBrand.id);
            setDeletingBrand(null);
          }}
        />
      ) : null}
    </div>
  );
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
  const busy = creating || saving;

  async function submit() {
    if (!name.trim() || busy) return;
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        industry: industry.trim() || undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
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
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
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

  async function submit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onRename(name.trim());
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
      onClick={onClose}
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
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
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

function DeleteBrandDialog({
  brand,
  onClose,
  onDelete,
}: {
  brand: BrandWorkspace;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="删除品牌套件"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_70px_rgba(30,30,60,0.22)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Trash2 className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold">删除“{brand.name}”？</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            该品牌套件中的项目、素材、规则和生成记录会一起删除，且无法恢复。
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            disabled={deleting}
            onClick={onClose}
            className="h-10 rounded-xl border border-border px-4 text-sm text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              void onDelete().finally(() => setDeleting(false));
            }}
            className="h-10 rounded-xl bg-destructive px-4 text-sm font-medium text-destructive-foreground disabled:opacity-60"
          >
            {deleting ? "删除中…" : "确认删除"}
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
 * page uses for `signIn`; it clears the session and returns to `/`.
 */
function UserMenu({
  user,
  brandName,
  isAdmin,
}: {
  user: { name: string; email: string; initial: string };
  brandName: string;
  isAdmin: boolean;
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
        aria-haspopup="menu"
        aria-expanded={open}
        className={[
          "flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors",
          open ? "bg-accent-soft" : "bg-muted hover:bg-accent-soft/60",
        ].join(" ")}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-sm font-semibold text-primary-foreground">
          {user.initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{user.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {brandName}
          </div>
        </div>
        <span
          className={[
            "shrink-0 text-xs text-muted-foreground transition-transform",
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
              href="/account"
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
                void signOut({ callbackUrl: "/" });
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
