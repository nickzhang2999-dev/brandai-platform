/**
 * P1.1 backfill — walk every existing BrandRule and project the legacy
 * free-form `value` Json into the matching strongly-typed module on
 * `structured`. Idempotent (re-runnable). Failures per row are logged but do
 * NOT abort: the goal is best-effort migration; `value` stays untouched as
 * fallback for unknown shapes.
 *
 * Run via: `pnpm --filter @brandai/db exec tsx prisma/migrations/20260521000000_vi_structured/seed-backfill.ts`
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Maps Prisma `RuleType` literal → VI module name.
const TYPE_TO_MODULE: Record<string, string> = {
  color: "color",
  font: "font",
  layout: "layout",
  imagery: "imagery",
  graphic: "graphic",
  copy: "copy_tone",
  logo: "logo",
};

// Best-effort mappers per module. Anything unrecognized falls into `extras`.
function mapValue(
  ruleType: string,
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  const moduleName = TYPE_TO_MODULE[ruleType];
  if (!moduleName) return null;
  const known = new Set<string>(KNOWN_KEYS[moduleName] ?? []);
  const out: Record<string, unknown> = { module: moduleName };
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (known.has(k)) out[k] = v;
    else if (k !== "colorSystem") extras[k] = v; // colorSystem stays on `value`
  }
  if (Object.keys(extras).length) out.extras = extras;
  return out;
}

const KNOWN_KEYS: Record<string, string[]> = {
  logo: [
    "clear_space_rule",
    "minimum_size",
    "allow_stroke",
    "allow_shadow",
    "allow_rotation",
    "allow_distortion",
    "allow_crop",
    "allow_opacity_change",
    "logo_dont_rules",
    "primary_logo_asset_id",
    "variants",
  ],
  color: [
    "palette",
    "combination_rules",
    "prohibited_combinations",
    "deviation_threshold",
    "allow_gradient",
    "brightness_preference",
    "saturation_preference",
  ],
  font: [
    "primary_font",
    "secondary_font",
    "fallback_fonts",
    "letter_spacing_rule",
    "line_height_rule",
    "license_status",
    "minimum_font_size",
    "text_hierarchy_rule",
    "allow_text_stroke",
    "allow_text_shadow",
    "allow_text_distortion",
  ],
  graphic: [
    "pattern_library",
    "shape_language",
    "allow_decoration",
    "prohibited_graphics",
  ],
  imagery: [
    "style_keywords",
    "lighting_rule",
    "composition_rule",
    "prohibited_visuals",
  ],
  layout: [
    "grid_system",
    "safe_margin_rule",
    "alignment_preference",
    "whitespace_ratio",
  ],
  copy_tone: [
    "tone_keywords",
    "prohibited_words",
    "preferred_words",
    "promotion_copy_rule",
    "punctuation_rule",
    "cta_rule",
  ],
};

async function main() {
  // Idempotent: only rows where `structured` is still NULL.
  const rules = await prisma.brandRule.findMany({
    where: { structured: { equals: null as never } },
  });
  let migrated = 0;
  let skipped = 0;
  for (const rule of rules) {
    try {
      const value =
        rule.value && typeof rule.value === "object"
          ? (rule.value as Record<string, unknown>)
          : {};
      const structured = mapValue(rule.type, value);
      if (!structured) {
        skipped++;
        continue;
      }
      await prisma.brandRule.update({
        where: { id: rule.id },
        data: { structured: structured as never },
      });
      migrated++;
    } catch (err) {
      console.warn(`[backfill] rule ${rule.id} failed:`, err);
    }
  }
  console.log(
    `[backfill] migrated=${migrated} skipped=${skipped} total=${rules.length}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
