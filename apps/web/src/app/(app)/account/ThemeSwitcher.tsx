"use client";

import { useEffect, useState } from "react";

/**
 * P3.1 · Skin switcher.
 *
 * 4 palettes share the same 16 semantic tokens (see packages/ui/src/styles.css):
 *   - light      → :root default, no class on <html>
 *   - dark       → .dark
 *   - theme-mono → .theme-mono
 *   - theme-tech → .theme-tech
 *
 * Persisted in localStorage under THEME_KEY. The pre-paint inline script in
 * app/layout.tsx reads the same key to avoid FOUC on reload.
 */

export const THEME_KEY = "brandai-theme";
export const THEME_CLASSES = ["dark", "theme-mono", "theme-tech"] as const;

type ThemeValue = "light" | (typeof THEME_CLASSES)[number];

const OPTIONS: { value: ThemeValue; label: string; desc: string }[] = [
  { value: "light", label: "Editorial Light", desc: "默认 · 奶白 + 勃艮第" },
  { value: "dark", label: "Editorial Dark", desc: "深墨 + 暖金" },
  { value: "theme-mono", label: "Mono Graphite", desc: "零彩度 · 纸感印刷" },
  { value: "theme-tech", label: "Tech Indigo", desc: "冷靛蓝 · 产品科技感" },
];

function applyTheme(value: ThemeValue) {
  const html = document.documentElement;
  THEME_CLASSES.forEach((c) => html.classList.remove(c));
  if (value !== "light") html.classList.add(value);
}

function readStoredTheme(): ThemeValue {
  if (typeof window === "undefined") return "light";
  const v = window.localStorage.getItem(THEME_KEY);
  if (v === "light" || (THEME_CLASSES as readonly string[]).includes(v ?? "")) {
    return v as ThemeValue;
  }
  return "light";
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeValue>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readStoredTheme());
    setMounted(true);
  }, []);

  function onChange(value: ThemeValue) {
    setTheme(value);
    applyTheme(value);
    try {
      window.localStorage.setItem(THEME_KEY, value);
    } catch {
      /* localStorage unavailable; in-session switch still works */
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        APPEARANCE · 界面皮肤
      </div>
      <h3 className="mt-1 font-serif text-lg text-foreground">配色主题</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        切换整站配色。所有皮肤共享同一套语义 token,组件不需要改。
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {OPTIONS.map((opt) => {
          const active = mounted && theme === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={
                "rounded-xl border px-4 py-3 text-left transition " +
                (active
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border bg-background hover:border-foreground/30")
              }
            >
              <div className="flex items-center justify-between">
                <span className="font-serif text-base text-foreground">
                  {opt.label}
                </span>
                <ThemeChip value={opt.value} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {opt.desc}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Render a 4-swatch preview using the theme's own tokens, regardless of which
 * theme is currently active. We do this by nesting the swatch row inside a
 * temporary class wrapper, so the inner tokens resolve against that theme.
 */
function ThemeChip({ value }: { value: ThemeValue }) {
  const wrapperClass = value === "light" ? "" : value;
  return (
    <span className={wrapperClass}>
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-1">
        <span className="block h-3 w-3 rounded-full bg-primary" />
        <span className="block h-3 w-3 rounded-full bg-accent" />
        <span className="block h-3 w-3 rounded-full bg-success" />
        <span className="block h-3 w-3 rounded-full bg-destructive" />
      </span>
    </span>
  );
}
