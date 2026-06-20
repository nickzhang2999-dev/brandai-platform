import * as React from "react";
import { Card, Badge } from "../components";
import { cn } from "../cn";

/**
 * AIInsightPanel — renders an AI-generated insight: conclusion + evidence list
 * + suggested actions. Pure presentational.
 *
 * @example
 * <AIInsightPanel
 *   conclusion="Brand palette drifts toward warm gold."
 *   evidence={["12 of 15 assets use #B89B5E", "logo accent stays burgundy"]}
 *   suggestions={["Lock muted-gold as secondary", "Avoid neon green"]}
 *   tone="risk"
 * />
 */
export interface AIInsightPanelProps {
  conclusion: string;
  evidence?: string[];
  suggestions?: string[];
  tone?: "pass" | "risk" | "danger" | "neutral";
  className?: string;
}

const toneLabel: Record<NonNullable<AIInsightPanelProps["tone"]>, string> = {
  pass: "Looks healthy",
  risk: "Needs attention",
  danger: "Critical",
  neutral: "Insight",
};

export function AIInsightPanel({
  conclusion,
  evidence,
  suggestions,
  tone = "neutral",
  className,
}: AIInsightPanelProps) {
  return (
    <Card className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-serif text-lg leading-snug">{conclusion}</p>
        <Badge tone={tone}>{toneLabel[tone]}</Badge>
      </div>
      {evidence && evidence.length > 0 ? (
        <section>
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
            Evidence
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {suggestions && suggestions.length > 0 ? (
        <section>
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
            Suggested actions
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}
