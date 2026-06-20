import * as React from "react";
import { cn } from "../cn";

/**
 * WorkflowStepper — horizontal stepper for wizard / onboarding flows.
 *
 * @example
 * <WorkflowStepper
 *   steps={[
 *     { id: "brief", label: "Brief" },
 *     { id: "preview", label: "Preview" },
 *     { id: "publish", label: "Publish" },
 *   ]}
 *   currentId="preview"
 * />
 */
export interface WorkflowStep {
  id: string;
  label: string;
}

export interface WorkflowStepperProps {
  steps: WorkflowStep[];
  currentId: string;
  onStepClick?: (id: string) => void;
  className?: string;
}

export function WorkflowStepper({
  steps,
  currentId,
  onStepClick,
  className,
}: WorkflowStepperProps) {
  const currentIdx = Math.max(
    0,
    steps.findIndex((s) => s.id === currentId),
  );
  return (
    <ol className={cn("flex items-center gap-3", className)}>
      {steps.map((step, idx) => {
        const state =
          idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo";
        const clickable = !!onStepClick;
        return (
          <React.Fragment key={step.id}>
            <li>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onStepClick?.(step.id)}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  state === "current" &&
                    "border-primary bg-primary text-primary-foreground",
                  state === "done" &&
                    "border-foreground/20 text-foreground/80",
                  state === "todo" &&
                    "border-foreground/15 text-muted-foreground",
                  clickable && "cursor-pointer",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px]",
                    state === "current"
                      ? "bg-primary-foreground/20"
                      : "bg-muted text-foreground/70",
                  )}
                >
                  {idx + 1}
                </span>
                <span>{step.label}</span>
              </button>
            </li>
            {idx < steps.length - 1 ? (
              <li
                aria-hidden
                className="h-px w-6 bg-foreground/15"
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </ol>
  );
}
