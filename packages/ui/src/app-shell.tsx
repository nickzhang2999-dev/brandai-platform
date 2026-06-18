"use client";

import * as React from "react";
import { cn } from "./cn";

export interface NavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
}

/**
 * App shell. Desktop (md+): fixed left sidebar. Mobile (<md): the sidebar is
 * hidden and reachable via a hamburger that opens it as an overlay drawer —
 * previously the sidebar was simply `hidden md:flex` with NO hamburger, so on
 * a phone the whole workspace nav was unreachable. Main padding also tightens
 * on small screens (p-4 → md:p-8).
 */
export function AppShell({
  nav,
  brandName,
  headerRight,
  children,
}: {
  nav: NavItem[];
  brandName: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  const navList = (onNavigate?: () => void) => (
    <nav className="flex flex-1 flex-col gap-1">
      {nav.map((item) => (
        <a
          key={item.href}
          href={item.href}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm transition-colors",
            item.active
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {item.icon}
          {item.label}
        </a>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card p-6 md:flex">
        <div className="mb-10">
          <div className="font-serif text-xl">OpenVisual</div>
          <div className="text-xs text-muted-foreground">{brandName}</div>
        </div>
        {navList()}
        <div className="mt-auto text-xs text-muted-foreground">
          P0 · Brand Visual AI
        </div>
      </aside>

      {/* Mobile drawer + backdrop */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="关闭导航"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-72 max-w-[80vw] flex-col border-r border-border bg-card p-6 shadow-xl">
            <div className="mb-8 flex items-center justify-between">
              <div>
                <div className="font-serif text-xl">OpenVisual</div>
                <div className="text-xs text-muted-foreground">{brandName}</div>
              </div>
              <button
                type="button"
                aria-label="关闭"
                className="rounded-lg p-1 text-xl leading-none text-muted-foreground hover:bg-muted"
                onClick={() => setMobileNavOpen(false)}
              >
                ×
              </button>
            </div>
            {navList(() => setMobileNavOpen(false))}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center gap-3 border-b border-border px-4 md:px-8">
          <button
            type="button"
            aria-label="打开导航"
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted md:hidden"
            onClick={() => setMobileNavOpen(true)}
          >
            {/* hamburger */}
            <span className="block h-0.5 w-5 bg-current" />
            <span className="mt-1 block h-0.5 w-5 bg-current" />
            <span className="mt-1 block h-0.5 w-5 bg-current" />
          </button>
          <div className="font-serif text-lg md:hidden">OpenVisual</div>
          <div className="ml-auto">{headerRight}</div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div>
        {eyebrow ? (
          <div className="mb-2 text-xs uppercase tracking-[0.2em] text-accent">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="font-serif text-3xl md:text-4xl">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
