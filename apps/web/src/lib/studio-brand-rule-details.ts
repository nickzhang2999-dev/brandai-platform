import { StudioAppliedBrandRule, type StudioAppliedBrandRule as RuleDetail } from "@brandai/contracts";
import { z } from "zod";

const record = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function studioBrandRuleDetail(value: unknown): RuleDetail | null {
  const rule = record(value);
  const palette = record(rule.structured).palette;
  const fallback = record(rule.value).colors;
  const colors = rule.type === "color"
    ? [...new Set((Array.isArray(palette) ? palette.map(entry => record(entry).hex) : Array.isArray(fallback) ? fallback : [])
        .filter((hex): hex is string => typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex))
        .map(hex => hex.toUpperCase()))].slice(0, 6)
    : [];
  const parsed = StudioAppliedBrandRule.safeParse({
    id: rule.id, type: rule.type, summary: rule.summary, strength: rule.strength,
    ...(colors.length ? { colors } : {}),
  });
  return parsed.success ? parsed.data : null;
}

export function appliedStudioBrandRules(params: unknown) {
  const output = record(params);
  const parsedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).safeParse(output.appliedBrandRuleCount);
  const appliedBrandRuleCount = parsedCount.success ? parsedCount.data : null;
  const snapshot = record(output.studioPostprocess).brandRules;
  const ids = z.array(z.string()).safeParse(output.appliedRuleIds);
  let appliedBrandRules: RuleDetail[] | null = null;
  if (appliedBrandRuleCount === 0) {
    appliedBrandRules = [];
  } else if (ids.success && Array.isArray(snapshot) && ids.data.length === appliedBrandRuleCount) {
    const byId = new Map(snapshot.map(value => [record(value).id, studioBrandRuleDetail(value)]));
    const matched = ids.data.map(id => byId.get(id) ?? null);
    if (matched.every((rule): rule is RuleDetail => rule !== null)) appliedBrandRules = matched;
  }
  return { appliedBrandRuleCount, appliedBrandRules };
}
