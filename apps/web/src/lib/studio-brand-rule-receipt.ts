import type { StudioBrandRuleReceipt } from "../../../../packages/contracts/src/studio-brand-rule-status";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : null;
const share = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

/** Only the exact worker-written shape is accepted; anything else reads as "not recorded". */
function colourFidelity(params: Record<string, unknown>) {
  const raw = object(params.colourFidelity);
  if (raw.checked !== true) return null;
  const present = Array.isArray(raw.present) ? raw.present.flatMap(entry => {
    const item = object(entry);
    const value = share(item.share), delta = typeof item.deltaE === "number" && Number.isFinite(item.deltaE) ? item.deltaE : null;
    return typeof item.hex === "string" && typeof item.closestDetected === "string" && value !== null && delta !== null
      ? [{ hex: item.hex, share: value, closestDetected: item.closestDetected, deltaE: delta }] : [];
  }) : [];
  const detected = Array.isArray(raw.detected) ? raw.detected.flatMap(entry => {
    const item = object(entry);
    const value = share(item.share);
    return typeof item.hex === "string" && value !== null ? [{ hex: item.hex, share: value }] : [];
  }) : [];
  const missing = strings(raw.missing);
  if (!missing || typeof raw.withinBrand !== "boolean") return null;
  return { checked: true, present, missing, neutral: strings(raw.neutral) ?? [], detected, withinBrand: raw.withinBrand };
}

/** Project only frozen worker evidence. Never query today's rule library or expose provider params. */
export function projectBrandRuleReceipt(output: { id: string; params: unknown }, workspaceId: string): StudioBrandRuleReceipt {
  const params = object(output.params), postprocess = object(params.studioPostprocess);
  const appliedRuleCount = count(params.appliedBrandRuleCount);
  const ids = Array.isArray(params.appliedRuleIds) && params.appliedRuleIds.every(id => typeof id === "string" && id.length > 0)
    ? [...new Set(params.appliedRuleIds as string[])] : null;
  const snapshots = Array.isArray(postprocess.brandRules) ? postprocess.brandRules : [];
  const rules = (ids ?? []).flatMap(id => {
    const rule = object(snapshots.find(value => object(value).id === id));
    return rule.workspaceId === workspaceId && rule.status === "CONFIRMED" && typeof rule.summary === "string" && typeof rule.type === "string" && typeof rule.strength === "string"
      ? [{ id, summary: rule.summary, type: rule.type, strength: rule.strength }] : [];
  });
  return { outputId: output.id, appliedRuleCount,
    mode: params.brandConstraintMode === "BRANDED" || params.brandConstraintMode === "FREE" ? params.brandConstraintMode : null,
    reason: params.brandRuleApplicationReason === "APPLIED" || params.brandRuleApplicationReason === "IMAGE_TOOL" || params.brandRuleApplicationReason === "NO_APPLICABLE_RULES" ? params.brandRuleApplicationReason : null,
    rules, detailsComplete: appliedRuleCount !== null && ids !== null && ids.length === appliedRuleCount && rules.length === appliedRuleCount,
    promptAdditionCount: Array.isArray(params.appliedPromptAdditions) && params.appliedPromptAdditions.every(value => typeof value === "string") ? params.appliedPromptAdditions.length : null,
    colourFidelity: colourFidelity(params),
  };
}
