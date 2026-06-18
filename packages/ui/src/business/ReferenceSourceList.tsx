import * as React from "react";
import { Card, Badge } from "../components";
import { cn } from "../cn";

/**
 * ReferenceSourceList — lists assets / rules that an AI generation drew upon.
 *
 * @example
 * <ReferenceSourceList
 *   items={[
 *     { id: "1", label: "logo-primary.svg", kind: "asset" },
 *     { id: "2", label: "Burgundy is the only accent", kind: "rule" },
 *   ]}
 * />
 */
export interface ReferenceSource {
  id: string;
  label: string;
  kind: "asset" | "rule" | "vi-doc" | "other";
  href?: string;
}

export interface ReferenceSourceListProps {
  items: ReferenceSource[];
  title?: string;
  className?: string;
}

const kindLabel: Record<ReferenceSource["kind"], string> = {
  asset: "Asset",
  rule: "Rule",
  "vi-doc": "VI",
  other: "Ref",
};

export function ReferenceSourceList({
  items,
  title = "引用来源",
  className,
}: ReferenceSourceListProps) {
  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <h3 className="font-serif text-base">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">(无引用来源)</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 px-3 py-2 text-sm"
            >
              <span className="truncate" title={it.label}>
                {it.href ? (
                  <a href={it.href} className="hover:underline">
                    {it.label}
                  </a>
                ) : (
                  it.label
                )}
              </span>
              <Badge tone="weak">{kindLabel[it.kind]}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
