import * as React from "react";
import { Card, Label, Textarea } from "../components";
import { cn } from "../cn";

/**
 * GenerationBriefBox — the "what to generate" input area for the wizard.
 * Wraps the briefing prompt + optional selling points; controlled component.
 *
 * @example
 * <GenerationBriefBox
 *   value={brief}
 *   onChange={setBrief}
 *   sellingPoints={points}
 *   onSellingPointsChange={setPoints}
 * />
 */
export interface GenerationBriefBoxProps {
  value: string;
  onChange: (v: string) => void;
  sellingPoints?: string;
  onSellingPointsChange?: (v: string) => void;
  className?: string;
}

export function GenerationBriefBox({
  value,
  onChange,
  sellingPoints,
  onSellingPointsChange,
  className,
}: GenerationBriefBoxProps) {
  return (
    <Card className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brief">需求 / Brief</Label>
        <Textarea
          id="brief"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="例如:为夏季促销活动生成一组英文社交海报…"
        />
      </div>
      {onSellingPointsChange ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="selling-points">卖点 / Selling points</Label>
          <Textarea
            id="selling-points"
            value={sellingPoints ?? ""}
            onChange={(e) => onSellingPointsChange(e.target.value)}
            placeholder="每行一个卖点"
          />
        </div>
      ) : null}
    </Card>
  );
}
