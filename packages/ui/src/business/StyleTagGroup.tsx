import * as React from "react";
import { cn } from "../cn";

/**
 * StyleTagGroup — selectable group of style tags (single or multi).
 * Pure controlled component.
 *
 * @example
 * <StyleTagGroup
 *   tags={["editorial", "minimal", "warm"]}
 *   selected={selected}
 *   onChange={setSelected}
 *   mode="multi"
 * />
 */
export interface StyleTagGroupProps {
  tags: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  mode?: "single" | "multi";
  className?: string;
}

export function StyleTagGroup({
  tags,
  selected,
  onChange,
  mode = "multi",
  className,
}: StyleTagGroupProps) {
  const toggle = (tag: string) => {
    const has = selected.includes(tag);
    if (mode === "single") {
      onChange(has ? [] : [tag]);
      return;
    }
    onChange(has ? selected.filter((t) => t !== tag) : [...selected, tag]);
  };
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {tags.map((tag) => {
        const active = selected.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            onClick={() => toggle(tag)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/20 text-foreground/70 hover:bg-muted",
            )}
          >
            {tag}
          </button>
        );
      })}
    </div>
  );
}
