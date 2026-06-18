/**
 * Shared Tailwind preset — OpenVisual editorial design language.
 *
 * P1.0: Dual theme.
 *   - editorial-light (default, UI v0.1 §7): Off White base + Burgundy accent.
 *   - editorial-dark (legacy, opt-in via `<html class="dark">`): kept for fallback.
 *
 * Token strategy: all palette tokens are CSS variables (RGB triplet, alpha-aware
 * via Tailwind `<alpha-value>`). Variables are defined in
 * packages/ui/src/styles.css under `:root` (light) and `.dark` (dark).
 *
 * Concrete palette literals are kept under their hue names for places that need
 * the raw color (charts, hand-drawn classNames). The semantic tokens
 * (background, foreground, primary, …) always go through the CSS variable so a
 * single `<html class="dark">` toggle flips the whole UI.
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

        // ── Legacy dark palette (kept for editorial-dark + back-compat) ──
        ink: {
          DEFAULT: "#16130f",
          soft: "#1f1b16",
          muted: "#2a251e",
          black: "#101010",
        },
        cream: {
          DEFAULT: "#f4efe6",
          soft: "#ebe4d6",
          dim: "#d8cfbc",
        },

        // ── Editorial-light raw palette (UI v0.1 §7) ──
        "off-white": "#F7F4EF",
        "warm-sand": "#E8DFD2",
        stone: "#D8D2C8",
        graphite: "#1D1D1F",
        burgundy: "#6E1F2B",
        olive: "#3E4A36",
        "muted-gold": "#B89B5E",
        "muted-gold-deep": "#8A7340",
        clay: "#B86F52",
        "soft-blue-gray": "#7C8A93",
      },
      borderRadius: {
        // shadcn/ui radius scale (was 1/1.5/2rem — those mega-rounds gave the
        // "bouncy warehouse" look). shadcn uses --radius: 0.5rem with sm/md/lg
        // derived from it. We keep names but bring them to shadcn values so the
        // app's existing rounded-lg/xl/2xl render like shadcn cards/inputs.
        sm: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
        "2xl": "0.75rem",
      },
      fontFamily: {
        serif: ['"Noto Serif SC"', "Georgia", "serif"],
        sans: ['"Inter"', '"PingFang SC"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        // shadcn elevation scale — subtle, layered, neutral. Replaces the
        // single near-invisible "hairline" drop.
        hairline: "0 1px 0 0 rgb(0 0 0 / 0.04)",
        sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        DEFAULT:
          "0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.08)",
        md: "0 4px 6px -1px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.06)",
        lg: "0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.06)",
      },
    },
  },
  plugins: [],
};
