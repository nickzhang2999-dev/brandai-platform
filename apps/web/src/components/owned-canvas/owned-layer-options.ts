import type { DecompositionInput, DecompositionTask, GenerationInput, GenerationTask } from "./owned-editor-api";

export type OwnedLayerMode = "AUTO" | "MANUAL";
type PsdSelection = Pick<GenerationInput, "psdLayerMode" | "psdLayerCount"> | Pick<GenerationTask, "psdLayerMode" | "psdLayerCount">;

/** Legacy requests with only a count are manual. A null count is not an
 * unrequested PSD when the immutable request explicitly chose AUTO. */
export function ownedPsdSelection(value?: PsdSelection | null) {
  return { requested: value?.psdLayerMode === "AUTO" || value?.psdLayerCount != null,
    mode: value?.psdLayerMode === "AUTO" ? "AUTO" as const : "MANUAL" as const,
    count: value?.psdLayerCount ?? 4 };
}
export function matchesOwnedPsdSelection(input: GenerationInput, task: GenerationTask) {
  const wanted = ownedPsdSelection(input), received = ownedPsdSelection(task);
  return wanted.requested === received.requested && (!wanted.requested || wanted.mode === received.mode
    && (wanted.mode === "AUTO" || wanted.count === received.count));
}
export function matchesOwnedDecomposition(input: DecompositionInput, task: DecompositionTask) {
  const mode = input.layerMode ?? "MANUAL";
  return input.mutationId === task.mutationId && input.projectId === task.projectId
    && input.assetId === task.assetId && input.assetSha256 === task.assetSha256 && input.sourceShapeId === task.sourceShapeId
    && input.documentRevision === task.documentRevision && mode === (task.layerMode ?? "MANUAL")
    && (mode === "AUTO" || input.layerCount === task.layerCount);
}
export function ownedLayerTaskTitle(task: DecompositionTask) {
  if (task.status === "SUCCEEDED") return `${task.layers.length} 个可编辑图层`;
  if ((task.layerMode ?? "MANUAL") !== "AUTO") return `${task.layerCount} 层分解`;
  return task.analysisStatus === "SUCCEEDED" ? `按内容拆分 · ${task.layerCount} 层方案` : "按内容自动分层";
}
export function ownedLayerTaskStatus(task: DecompositionTask) {
  if (task.status === "SUCCEEDED") return "图层已保存";
  if (task.status === "FAILED") return "未完成，原图保留";
  if (Date.parse(task.expiresAt) <= Date.now()) return "等待确认超时，可刷新任务";
  if (task.layerMode === "AUTO" && ["PENDING", "RUNNING"].includes(task.analysisStatus)) {
    return task.analysisStatus === "RUNNING" ? "正在分析图片内容" : "等待内容分析";
  }
  return task.status === "RUNNING" ? "正在拆分图层" : "等待处理";
}

export function ownedLayerTaskNotice(task: DecompositionTask) {
  if (task.status === "SUCCEEDED") return "图层已保存，可展开到画布或下载 PSD。";
  if (task.status === "FAILED") return task.error || "分层未完成，原图片保留。任务已停止，不会自动重复调用模型。";
  if (Date.parse(task.expiresAt) <= Date.now()) return "分层等待已超时，请刷新查看最终结果；不会自动重新提交。";
  return `${ownedLayerTaskStatus(task)}。关闭页面后任务仍会继续，可稍后回到此项目查看。`;
}
