import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

/**
 * Primitive UI components for OpenVisual.
 *
 * P1.0: defaults are theme-aware via semantic tokens (background / foreground /
 * primary / muted / border / ring). Switching `<html class="dark">` flips the
 * whole palette without changing any class names below.
 */

// shadcn/ui Button: medium radius (not a pill), compact heights, subtle
// shadow on solid variants, ring-offset focus. The old `rounded-full` pills +
// tall h-10/h-12 were a big part of the "not shadcn" feel.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        outline:
          "border border-border bg-card text-foreground shadow-sm hover:bg-muted hover:text-foreground",
        ghost: "text-foreground/80 hover:bg-muted hover:text-foreground",
        destructive:
          "bg-destructive text-white shadow-sm hover:bg-destructive/90",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // shadcn/ui Card: lg radius, neutral border, soft layered shadow on a
        // clean card surface. p-6 default.
        "rounded-lg border border-border bg-card text-card-foreground p-6 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

/**
 * "CreamCard" is the high-contrast editorial card.
 * It renders on the neutral page surface in light, and lifts onto the dark
 * card surface in dark — both via semantic tokens so nested inputs/labels
 * (which also use tokens) stay legible. The previous `dark:bg-cream
 * dark:text-ink` painted a near-white card in dark mode while its contents
 * flipped to dark, producing unreadable panels on the login / admin pages.
 */
export function CreamCard({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl bg-background text-foreground p-6 shadow-sm border border-foreground/10 dark:bg-card dark:text-card-foreground dark:border-border",
        className,
      )}
      {...props}
    />
  );
}

// shadcn/ui Badge: compact rounded-md, smaller padding, with a subtle ring
// for the tonal variants. Was a big rounded-full pill.
const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        strong: "bg-primary text-primary-foreground",
        weak: "border border-foreground/20 text-foreground/70",
        // Semantic tone tokens (theme-aware via CSS vars).
        danger: "bg-destructive/15 text-destructive",
        pass: "bg-success/15 text-success",
        risk: "bg-warning/15 text-warning",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props} />
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-serif text-4xl">{value}</span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </Card>
  );
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      {...props}
    />
  );
}

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-sm font-medium text-foreground/70", className)}
      {...props}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}
