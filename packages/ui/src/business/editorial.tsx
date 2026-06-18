import * as React from "react";
import { cn } from "../cn";

/**
 * Editorial AI Workspace — shared composition primitives (UI 风格定义 §3, §7-10).
 *
 * The named business components (BrandDNAPanel, VisualAssetCard, …) are content
 * shells; these are the page-level layout atoms (kickers, headers, panels, tags)
 * that give every screen the same warm-minimal, gallery-like, serif+mono cadence
 * instead of an admin look. All presentational → usable from Server Components.
 */

/** Mono, uppercase, wide-tracked kicker. `tone="accent"` = muted gold. */
export function Eyebrow({
  children,
  tone = "muted",
  className,
}: {
  children: React.ReactNode;
  tone?: "muted" | "accent";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "font-mono text-[11px] uppercase tracking-[0.25em]",
        tone === "accent" ? "text-accent" : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Page-level editorial header: kicker + serif title + subtitle + right actions. */
export function EditorialHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <Eyebrow className="mb-3">{eyebrow}</Eyebrow> : null}
        <h1 className="font-serif text-4xl leading-tight md:text-5xl">{title}</h1>
        {subtitle ? (
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap gap-3">{actions}</div>
      ) : null}
    </header>
  );
}

/** In-page section heading: gold kicker + serif H2 + optional right action. */
export function SectionHeading({
  eyebrow,
  title,
  action,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4", className)}>
      <div>
        {eyebrow ? <Eyebrow tone="accent">{eyebrow}</Eyebrow> : null}
        <h2 className="mt-2 font-serif text-2xl md:text-3xl">{title}</h2>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * Panel — large editorial surface (warm-sand card, generous padding).
 *
 * P3.2 polish — drops the visible shadow so inner cards (bg-background)
 * can lift above the Panel via the §9.3 hairline-shadow they carry. Layer
 * rhythm: page(off-white) → Panel(warm-sand, flat) → Card(off-white, hairline)
 * → inner well(warm-sand again or muted/40).
 */
export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        // shadcn-style section card: lg radius (was rounded-3xl), neutral
        // border + soft shadow, tighter padding.
        "rounded-lg border border-border bg-card p-6 shadow-sm md:p-8",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Thin mono label above a sub-block (e.g. "色彩系统 · COLOR"). */
export function FieldLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Single feature pill (§10.4: 浅底·细边·小圆角·不花哨). Complements StyleTagGroup. */
export function StyleTag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-foreground/15 bg-muted px-3 py-1 text-xs text-foreground/80",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Demoted stat: mono number + tiny muted label. For low-emphasis strips. */
export function MiniStat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="font-mono text-2xl text-foreground">{value}</span>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** Brand color chip with hex caption (色彩系统 / Brand DNA). */
export function ColorSwatch({
  hex,
  name,
  className,
}: {
  hex: string;
  name?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        className="h-16 w-16 rounded-2xl border border-foreground/10 shadow-sm"
        style={{ backgroundColor: hex }}
        aria-label={name ?? hex}
      />
      <div className="flex flex-col leading-tight">
        {name ? <span className="text-xs text-foreground/70">{name}</span> : null}
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {hex}
        </span>
      </div>
    </div>
  );
}
