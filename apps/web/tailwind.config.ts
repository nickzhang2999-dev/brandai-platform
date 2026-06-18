import type { Config } from "tailwindcss";
import preset from "@brandai/config/tailwind-preset.js";

export default {
  presets: [preset as Partial<Config>],
  content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
} satisfies Config;
