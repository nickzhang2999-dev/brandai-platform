/**
 * Shared Tailwind preset — BrandAI design language.
 *
 * Single brand color = violet #7C5CFF, soft lavender surfaces, near-white
 * neutral page, Inter as the only type family (docs/04_UI视觉规范文档.md).
 *
 * Token strategy: all palette tokens are CSS variables (RGB triplet, alpha-aware
 * via Tailwind `<alpha-value>`). Variables are defined in
 * packages/ui/src/styles.css under `:root` (light) and `.dark` (dark), so a
 * single `<html class="dark">` toggle flips the whole UI.
 *
 * The raw color literals below are kept under their legacy hue names so the
 * components migrated from the old codebase keep compiling; their values are
 * remapped to the BrandAI violet/neutral family (no more warm tan surfaces).
 */
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // ── Semantic tokens (theme-aware via CSS variables) ──
        background: v("--bg"),
        foreground: v("--fg"),
        card: v("--card"),
        "card-foreground": v("--card-fg"),
        muted: v("--muted"),
        "muted-foreground": v("--muted-fg"),
        primary: v("--primary"),
        "primary-foreground": v("--primary-fg"),
        accent: {
          DEFAULT: v("--accent"),
          soft: v("--accent-soft"),
          deep: v("--accent-deep"),
        },
        destructive: v("--destructive"),
        border: v("--border"),
        ring: v("--ring"),
        success: v("--success"),
        warning: v("--warning"),

        // ── Legacy raw palette names, remapped to the BrandAI family ──
        // (kept defined so components migrated from the old codebase compile;
        //  warm tans → violet/neutral so nothing renders "sticky-note" warm.)
        ink: {
          DEFAULT: "#1F1F2A",
          soft: "#2A2A38",
          muted: "#3A3A4A",
          black: "#111117",
        },
        cream: {
          DEFAULT: "#FFFFFF",
          soft: "#FAFAFC",
          dim: "#F6F5FA",
        },
        "off-white": "#FAFAFC",
        "warm-sand": "#F4F0FF",
        stone: "#ECECF3",
        graphite: "#1F1F2A",
        burgundy: "#7C5CFF",
        olive: "#34A853",
        "muted-gold": "#8B6CFF",
        "muted-gold-deep": "#5B3FE0",
        clay: "#8B6CFF",
        "soft-blue-gray": "#6B6B7A",

        // ── BrandAI named palette (designer spec) ──
        violet: "#7C5CFF",
        "violet-bright": "#8B6CFF",
        "violet-deep": "#5B3FE0",
        lavender: "#F4F0FF",
        "lavender-light": "#FAF8FF",
      },
      borderRadius: {
        // BrandAI uses softer, rounder corners than shadcn defaults: cards
        // 20-24px, inputs ~34px (rounded-3xl/full), buttons ~18px, chips full.
        sm: "0.5rem",     /* 8px  */
        md: "0.75rem",    /* 12px */
        lg: "1rem",       /* 16px */
        xl: "1.25rem",    /* 20px */
        "2xl": "1.5rem",  /* 24px */
        "3xl": "2rem",    /* 32px (modals / hero input) */
      },
      fontFamily: {
        // Single type family. `serif` is aliased to Inter so the ~80 legacy
        // `font-serif` heading usages render in Inter without per-file edits.
        serif: ['"Inter"', '"PingFang SC"', "system-ui", "sans-serif"],
        sans: ['"Inter"', '"PingFang SC"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        // BrandAI elevation: soft, violet-tinted, layered (docs §阴影系统).
        hairline: "0 1px 0 0 rgb(30 30 60 / 0.04)",
        sm: "0 4px 12px -2px rgb(30 30 60 / 0.05)",
        DEFAULT: "0 8px 24px rgb(30 30 60 / 0.06)",
        md: "0 12px 32px -4px rgb(30 30 60 / 0.08)",
        lg: "0 20px 60px -8px rgb(30 30 60 / 0.12)",
        focus: "0 0 0 4px rgb(124 92 255 / 0.08)",
      },
    },
  },
  plugins: [],
};
