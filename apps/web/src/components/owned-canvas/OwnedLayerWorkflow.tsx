import type { DecompositionTask } from "./owned-editor-api";

const actionLabels = {
  INFER_BACKGROUND: "可依据周边补全", KEEP_GROUPED: "建议保留成组",
  VISIBLE_ONLY: "先提取可见部分", REFERENCE_REQUIRED: "补全前需要参考素材",
};
const shadowLabels = {
  NONE_VISIBLE: "未发现明确投影", KEEP_WITH_SUBJECT: "投影应与主体一起处理",
  SEPARATE_IF_VERIFIED: "核实可提取后再拆出投影", KEEP_ENVIRONMENT: "保留环境阴影", UNCERTAIN: "投影归属需要核对",
};

export function OwnedLayerWorkflow({ task }: { task: DecompositionTask }) {
  const assessment = task.workflow?.assessment;
  if (!assessment) return null;
  return <details className="rounded-xl border border-border p-3 text-xs leading-5" data-testid="owned-layer-assessment">
    <summary className="cursor-pointer font-medium">画面判断与后续处理建议</summary>
    <div className="mt-2 space-y-3">
      {assessment.occlusions.length > 0 ? <ul className="space-y-2">{assessment.occlusions.map(item => <li key={item.target}>
        <p className="font-medium">{item.target} · {actionLabels[item.action]}</p>
        <p className="text-muted-foreground">依据：{item.evidence}。{item.reason}</p>
      </li>)}</ul> : <p>本次分析未发现明确的遮挡补全需求。</p>}
      <p>{shadowLabels[assessment.shadowPolicy]}：{assessment.shadowEvidence}</p>
      <div><p className="font-medium">需要保留</p><ul className="list-inside list-disc">{assessment.preserve.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
      <p className="text-muted-foreground">这是处理建议。本次仅执行图层分解，未执行专门的背景或投影修复。请单独查看背景、移开主体检查残影；自然补全也不等于找回被遮住的原始像素。</p>
    </div>
  </details>;
}
