import * as React from "react";
import { Card } from "../components";
import { cn } from "../cn";

/**
 * BrandDNAPanel — surfaces the workspace's brand DNA report (colors, rules,
 * typography). Pure layout shell; the caller renders the actual sections
 * (color system, contrast/consistency cards, rules list, etc.) as children.
 *
 * @example
 * <BrandDNAPanel title="Brand DNA · Acme">
 *   <ConsistencyScoreCard ... />
 *   <ColorSystemReport ... />
 * </BrandDNAPanel>
 */
export interface BrandDNAPanelProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}

export function BrandDNAPanel({
  title = "Brand DNA",
  subtitle,
  children,
  className,
}: BrandDNAPanelProps) {
  return (
    <Card className={cn("flex flex-col gap-5", className)}>
      <header className="flex flex-col gap-1">
        <h3 className="font-serif text-xl">{title}</h3>
        {subtitle ? (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </Card>
  );
}
