"use client";

import React from "react";
import type { GenerationTask } from "./owned-editor-api";

const types: Record<string, string> = { logo: "标志", color: "色彩", font: "字体", layout: "布局", imagery: "影像", copy: "文案", graphic: "图形" };

/** Uses saved generation receipts only. It intentionally has no library fetch. */
export function GenerationBrandRuleReceipt({ task }: { task: Pick<GenerationTask, "status" | "appliedBrandRuleCount"> & Partial<Pick<GenerationTask, "brandRuleReceipts">> }) {
  if (task.status !== "SUCCEEDED") return null;
  const receipts = task.brandRuleReceipts ?? [];
  if (!receipts.length) return <p className="text-xs text-muted-foreground" data-testid="owned-generation-rule-count">{task.appliedBrandRuleCount === null
    ? "历史任务未记录品牌规则应用证据。" : task.appliedBrandRuleCount > 0 ? `已传入 ${task.appliedBrandRuleCount} 条品牌规则；历史任务未记录明细。` : "本次未应用品牌规则；历史任务未记录原因。"}</p>;
  return <div className="space-y-2 text-xs text-muted-foreground" data-testid="owned-generation-rule-count">
    {receipts.map((receipt, index) => <details key={receipt.outputId} data-testid="generation-brand-rule-receipt">
      <summary className="cursor-pointer">{receipts.length > 1 ? `结果 ${index + 1} · ` : ""}{receipt.appliedRuleCount === null ? "品牌规则应用证据未记录" : receipt.appliedRuleCount > 0 ? `已传入 ${receipt.appliedRuleCount} 条品牌规则` : "本次未应用品牌规则"} · 查看回执</summary>
      <div className="mt-2 space-y-2 rounded-xl bg-muted p-3">
        {receipt.mode && <p>生成模式：{receipt.mode === "BRANDED" ? "品牌约束" : "自由创作"}</p>}
        {receipt.reason === "IMAGE_TOOL" && <p>本次是专用图片工具，按工具用途不套用全套品牌规则。</p>}
        {receipt.reason === "NO_APPLICABLE_RULES" && <p>生成时没有可应用规则，或“应用到项目”开关已关闭。</p>}
        {receipt.appliedRuleCount === 0 && receipt.reason === null && <p>历史任务未记录未应用原因；当前品牌设置不能代替当时状态。</p>}
        {receipt.rules.length > 0 && <ul className="space-y-1">{receipt.rules.map(rule => <li key={rule.id}><span className="font-medium">{types[rule.type] ?? rule.type}</span> · {rule.summary} <span>（{rule.strength === "FORBIDDEN" ? "禁止项" : rule.strength === "STRONG" ? "强约束" : rule.strength === "WEAK" ? "弱约束" : rule.strength}）</span></li>)}</ul>}
        {!receipt.detailsComplete && <p>部分历史规则明细未记录，无法据此还原完整规范。</p>}
        {receipt.promptAdditionCount !== null && <p>生成回执记录 {receipt.promptAdditionCount} 条附加约束（可能包含项目要求和禁用项）。</p>}
        {/* The check compares finished pixels with the palette that was sent, so
            a miss means "the model did not follow", not "the rule was missing". */}
        {receipt.colourFidelity ? <div data-testid="generation-colour-fidelity" className={receipt.colourFidelity.withinBrand ? "" : "text-primary"}>
          <p>{receipt.colourFidelity.withinBrand
            ? receipt.colourFidelity.missing.length
              ? `颜色核对：品牌色找到 ${receipt.colourFidelity.present.length} 个，${receipt.colourFidelity.missing.length} 个未出现。`
              : "颜色核对：品牌色均已出现。"
            : receipt.colourFidelity.neutral.length && !receipt.colourFidelity.missing.length
              ? "颜色核对：品牌色均为中性色，无法据此判断是否遵循。"
              : "颜色核对：未检测到任何品牌色，模型可能未遵循颜色规范。"}</p>
          {!!receipt.colourFidelity.present.length && <p>{receipt.colourFidelity.present.map(item => `${item.hex}（${Math.round(item.share * 100)}%）`).join("、")}</p>}
          {!!receipt.colourFidelity.missing.length && receipt.colourFidelity.withinBrand && <p>未出现：{receipt.colourFidelity.missing.join("、")}</p>}
        </div> : receipt.appliedRuleCount ? <p>这次生成没有颜色核对记录（检查上线前的结果，或品牌未声明颜色）。</p> : null}
        <p>以上为生成时的传入记录；图片是否遵守规范仍需检查。</p>
      </div>
    </details>)}
  </div>;
}
