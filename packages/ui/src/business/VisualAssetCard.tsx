import * as React from "react";
import { Card, Badge } from "../components";
import { cn } from "../cn";

/**
 * VisualAssetCard — a single visual asset tile (logo / image / mockup).
 *
 * @example
 * <VisualAssetCard
 *   name="hero.png"
 *   thumbUrl="/uploads/hero.png"
 *   tags={["primary", "hero"]}
 *   meta="1920×1080 · 312 KB"
 * />
 */
export interface VisualAssetCardProps {
  name: string;
  thumbUrl?: string | null;
  tags?: string[];
  meta?: string;
  onClick?: () => void;
  className?: string;
}

export function VisualAssetCard({
  name,
  thumbUrl,
  tags,
  meta,
  onClick,
  className,
}: VisualAssetCardProps) {
  return (
    <Card
      className={cn("flex flex-col gap-3 p-3", className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <div className="aspect-square w-full overflow-hidden rounded-lg bg-muted">
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbUrl}
            alt={name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            (no preview)
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1">
        <div className="truncate text-sm font-medium" title={name}>
          {name}
        </div>
        {meta ? (
          <div className="text-xs text-muted-foreground">{meta}</div>
        ) : null}
        {tags && tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((t) => (
              <Badge key={t} tone="weak" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
