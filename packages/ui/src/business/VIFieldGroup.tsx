import * as React from "react";
import { cn } from "../cn";

/**
 * VIFieldGroup — minimal grouping shell for VI module field forms.
 *
 * Renders a labeled section that wraps a vertical column of fields, used by
 * the rules/* form pages to assemble strongly-typed BrandRule.structured
 * payloads. Pure layout, no form logic — callers own controlled state and
 * validation against the matching zod schema in `@brandai/contracts/vi`.
 *
 * @example
 * <VIFieldGroup
 *   title="Logo 规范"
 *   description="基础留白、最小尺寸、禁用变换"
 * >
 *   <Label>clear_space_rule</Label>
 *   <Input ... />
 * </VIFieldGroup>
 */
export interface VIFieldGroupProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function VIFieldGroup({
  title,
  description,
  children,
  footer,
  className,
}: VIFieldGroupProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-card p-5",
        className,
      )}
    >
      <header className="flex flex-col gap-0.5">
        <h4 className="font-serif text-lg text-foreground">{title}</h4>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </header>
      <div className="grid gap-3">{children}</div>
      {footer ? <footer className="pt-1">{footer}</footer> : null}
    </section>
  );
}
