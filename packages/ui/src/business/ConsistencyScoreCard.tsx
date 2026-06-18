import * as React from "react";
import { Card } from "../components";
import { cn } from "../cn";

/**
 * ConsistencyScoreCard — large-typography brand consistency / contrast score
 * (0–100). Mirrors the AIVI1 mockup for the Color System report.
 *
 * @example
 * <ConsistencyScoreCard label="Color Consistency" score={82} hint="across 15 assets" />
 */
export interface ConsistencyScoreCardProps {
  label: string;
  score: number;
  hint?: string;
  tone?: "pass" | "risk" | "danger";
  className?: string;
}

function toneFor(score: number): "pass" | "risk" | "danger" {
  if (score >= 80) return "pass";
  if (score >= 60) return "risk";
  return "danger";
}

const toneText: Record<"pass" | "risk" | "danger", string> = {
  pass: "text-success",
  risk: "text-warning",
  danger: "text-destructive",
};

export function ConsistencyScoreCard({
  label,
  score,
  hint,
  tone,
  className,
}: ConsistencyScoreCardProps) {
  const t = tone ?? toneFor(score);
  return (
    <Card className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn("font-serif text-5xl leading-none", toneText[t])}>
        {Math.round(score)}
        <span className="ml-1 text-xl text-muted-foreground">/100</span>
      </span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </Card>
  );
}
