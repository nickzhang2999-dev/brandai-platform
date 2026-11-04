import type { VisualFidelityReport } from "@brandai/contracts";

const labels = { pass: "通过", fail: "需要调整", unknown: "待核验", not_applicable: "未设置适用约束" };

/** Only evidence bound to this output can describe its subject fidelity. */
export function visualFidelityPresentation(report: VisualFidelityReport | null | undefined, outputSha256: string) {
  if (!report) return { status: "unknown" as const, reason: "尚无主体级证据。品牌检查或整图色板不能代替主体属性核验。", current: false };
  if (report.outputSha256 !== outputSha256) return { status: "unknown" as const, reason: "检查对应的图片已变化，当前图片需重新核验。", current: false };
  if (!report.checkPerformed && report.overall !== "not_applicable") return { status: "unknown" as const, reason: "主体级检查尚未实际完成，请查看待核验原因。", current: true };
  return { status: report.overall, reason: report.overall === "fail" ? "存在约束偏离，生成图片已保留。" : report.overall === "unknown" ? "部分约束证据不足，请查看逐项原因。" : report.overall === "not_applicable" ? "本次未设置适用约束。" : "当前图片的适用硬约束已通过 AI 核验。", current: true };
}

export function GenerationVisualFidelity({ report, outputSha256, compact = false }: {
  report?: VisualFidelityReport | null; outputSha256: string; compact?: boolean;
}) {
  const view = visualFidelityPresentation(report, outputSha256);
  return <details open={compact ? undefined : true} className="space-y-2 text-xs" data-testid="owned-visual-fidelity" data-status={view.status}>
    <summary className="cursor-pointer text-muted-foreground">主体与品牌保真 · {labels[view.status]}</summary>
    <p className="leading-5 text-muted-foreground">{view.reason}</p>
    {view.current && report && <>
      <ul className="space-y-2">{report.checks.map((check, index) => <li key={`${check.id}:${index}`}>
        <p>{labels[report.checkPerformed ? check.status : "unknown"]}{check.objectRegion ? ` · ${check.objectRegion}` : ""} · {check.observation}</p>
        {!!check.evidence.length && <p className="mt-1 break-words text-muted-foreground">依据：{check.evidence}</p>}
      </li>)}</ul>
      {report.warnings.map((warning, index) => <p key={index} className="text-muted-foreground">{warning}</p>)}
    </>}
  </details>;
}
