import { createHash } from "node:crypto";
import { VisualFidelityReport } from "@brandai/contracts";
import { StudioVisualFidelitySnapshot } from "./studio-visual-fidelity";

export type FidelitySnapshot = StudioVisualFidelitySnapshot;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function readFidelitySnapshot(raw: unknown) {
  if (raw === undefined || raw === null) return { fidelitySnapshot: null, fidelityHash: null };
  const fidelityHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  const value = object(raw), parsed = StudioVisualFidelitySnapshot.safeParse(raw);
  const inputSha256 = typeof value.inputSha256 === "string" && /^[a-f0-9]{64}$/.test(value.inputSha256) ? value.inputSha256 : fidelityHash;
  const fidelitySnapshot: FidelitySnapshot = parsed.success ? parsed.data : { revision: "visual-fidelity-guard/1", inputSha256,
    plan: null, unavailableReason: "保真约束快照不可用。", editSource: null, imageTool: false, referenceImages: [] };
  return { fidelitySnapshot, fidelityHash };
}

export function unknownFidelity(snapshot: FidelitySnapshot, outputSha256: string, reason: string): VisualFidelityReport {
  return { revision: "visual-fidelity-guard/1", inputSha256: snapshot.inputSha256, outputSha256, overall: "unknown", checkPerformed: false,
    checks: (snapshot.plan?.constraints ?? []).map(c => ({ id: c.id, status: "unknown", observation: reason, evidence: "尚无可用视觉证据" })), warnings: [reason] };
}

/** The saved plan, never the model's overall, owns coverage and hard/soft aggregation. */
export function reviewFidelity(snapshot: FidelitySnapshot | null | undefined, outputSha256: string, rawReport: unknown, sourceAvailable: boolean, sourceError?: string): VisualFidelityReport | null {
  if (!snapshot) return null;
  if (snapshot.unavailableReason || !snapshot.plan) return unknownFidelity(snapshot, outputSha256, snapshot.unavailableReason || "本次尚无可用保真约束清单。");
  if (sourceError || snapshot.editSource && !sourceAvailable || snapshot.plan.constraints.some(c => c.source === "source") && !sourceAvailable)
    return unknownFidelity(snapshot, outputSha256, sourceError || "原始主体图片不可用，无法比较保留属性。");
  const parsed = VisualFidelityReport.safeParse(rawReport);
  if (!parsed.success || parsed.data.inputSha256 !== snapshot.inputSha256 || parsed.data.outputSha256 !== outputSha256)
    return unknownFidelity(snapshot, outputSha256, "主体级视觉报告缺失、未执行或版本不匹配。");
  const report = parsed.data;
  if (!report.checkPerformed) return report.overall === "unknown" ? { ...report, checks: report.checks.map(check => ({ ...check, status: "unknown" })) }
    : unknownFidelity(snapshot, outputSha256, "主体级检查尚未实际执行。");
  const ids = new Set(snapshot.plan.constraints.map(c => c.id));
  const coverageIncomplete = report.checks.length !== ids.size || new Set(report.checks.map(c => c.id)).size !== ids.size || report.checks.some(c => !ids.has(c.id));
  const hard = snapshot.plan.constraints.filter(c => c.strength === "hard");
  const checks = snapshot.plan.constraints.map(constraint => {
    const candidates = report.checks.filter(check => check.id === constraint.id);
    if (candidates.length !== 1) return { id: constraint.id, status: "unknown" as const, observation: "该约束检查缺失或重复，无法确定结果。", evidence: "尚无唯一有效证据" };
    const check = candidates[0]!;
    return check.status !== "unknown" && (!check.objectRegion || /whole[- ]image palette|global palette|整图色板|全图配色|整图配色/i.test(check.evidence + " " + check.objectRegion))
      ? { ...check, status: "unknown" as const, observation: "尚未定位约束对象；" + check.observation } : check;
  });
  const status = (id: string) => checks.find(c => c.id === id)!.status;
  const overall = hard.some(c => status(c.id) === "fail") ? "fail" : coverageIncomplete || hard.some(c => status(c.id) === "unknown") ? "unknown" : hard.length ? "pass" : "not_applicable";
  const warnings = [...report.warnings, ...(coverageIncomplete ? ["视觉报告存在遗漏、重复或未知约束，部分检查待核验。"] : []), ...snapshot.plan.constraints.filter(c => c.strength === "soft" && status(c.id) !== "pass").map(c => `偏好尚未满足：${c.target} · ${c.expected}`)];
  return { ...report, checks, overall, warnings };
}
