import * as React from "react";
import { Card } from "../components";
import { cn } from "../cn";

/**
 * VersionCompareView — side-by-side image comparison for two generation versions.
 * Display-only; the full diff/metric table from M6's version-compare.tsx stays
 * in the page-level component (this wrapper only renders the visual juxtaposition).
 *
 * @example
 * <VersionCompareView
 *   left={{ label: "v1", imageUrl: "/a.png" }}
 *   right={{ label: "v2", imageUrl: "/b.png" }}
 * />
 */
export interface VersionCompareSide {
  label: string;
  imageUrl?: string | null;
  caption?: string;
}

export interface VersionCompareViewProps {
  left: VersionCompareSide;
  right: VersionCompareSide;
  className?: string;
}

function Side({ side }: { side: VersionCompareSide }) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {side.label}
      </div>
      <div className="aspect-square w-full overflow-hidden rounded-xl border border-foreground/10 bg-muted">
        {side.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={side.imageUrl}
            alt={side.label}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            (no preview)
          </div>
        )}
      </div>
      {side.caption ? (
        <div className="text-xs text-muted-foreground">{side.caption}</div>
      ) : null}
    </div>
  );
}

export function VersionCompareView({
  left,
  right,
  className,
}: VersionCompareViewProps) {
  return (
    <Card className={cn("flex flex-col gap-4 md:flex-row", className)}>
      <Side side={left} />
      <Side side={right} />
    </Card>
  );
}
