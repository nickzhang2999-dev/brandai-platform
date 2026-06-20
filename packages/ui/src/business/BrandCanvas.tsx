import * as React from "react";
import { cn } from "../cn";

/**
 * BrandCanvas — outermost editorial frame that hosts a workspace dashboard.
 *
 * Renders an off-white serif-titled section with optional eyebrow and side actions.
 * Pure presentational; no store / no router.
 *
 * @example
 * <BrandCanvas eyebrow="Workspace" title="Acme · Brand Visual">
 *   <StatCard ... />
 * </BrandCanvas>
 */
export interface BrandCanvasProps {
  eyebrow?: string;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function BrandCanvas({
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
}: BrandCanvasProps) {
  return (
    <section
      className={cn(
        "rounded-3xl border border-foreground/10 bg-background p-8",
        className,
      )}
    >
      {(eyebrow || title || actions) && (
        <header className="mb-6 flex items-end justify-between gap-6">
          <div>
            {eyebrow ? (
              <div className="mb-2 text-xs uppercase tracking-[0.2em] text-accent">
                {eyebrow}
              </div>
            ) : null}
            {title ? (
              <h2 className="font-serif text-2xl md:text-3xl">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}
