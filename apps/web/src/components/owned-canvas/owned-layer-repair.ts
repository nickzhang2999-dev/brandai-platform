import { requireOwnedLayerSource } from "../../lib/owned-canvas-decomposition";
import type { OwnedCanvasDocument, OwnedCanvasItem } from "../../lib/owned-canvas-model";
import type { DecompositionTask, PersistentImage } from "./owned-editor-api";

export const OWNED_LAYER_REPAIR_INSTRUCTION = "擦除涂抹区域中的主体及需要移除的投影，依据周围纹理与结构补全背景。保留未涂抹区域的原始像素，不添加新的主体、文字或标志。";

/** The task's original frame is the only repair target. A visually similar
 * layer, copied source shape, or latest selection never substitutes for it. */
export function requireOwnedLayerRepairSource(document: OwnedCanvasDocument | null, task: DecompositionTask, projectId: string): OwnedCanvasItem {
  if (task.projectId !== projectId || task.status !== "SUCCEEDED") throw new Error("请先读取当前项目已完成的分层任务。");
  if (!document || !document.items.some(item => item.id === task.sourceShapeId && item.kind === "image"
    && item.assetId === task.assetId && item.assetSha256 === task.assetSha256)) throw new Error("分层原图已不在画布上或已变化，请先恢复这次分层使用的原图。");
  const item = requireOwnedLayerSource(document, task);
  if (item.crop || item.flipX || item.flipY || Math.abs(item.rotation) > 1e-6) throw new Error("请先重置原图的裁切、翻转和旋转，再绘制背景修复区域。");
  return item;
}

export function requireOwnedLayerRepairMaterial(materials: PersistentImage[], task: DecompositionTask, workspaceId: string): PersistentImage {
  const material = materials.find(value => value.assetId === task.assetId && value.assetSha256 === task.assetSha256);
  if (!material || material.width !== task.sourceWidth || material.height !== task.sourceHeight
    || material.url !== `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(task.assetId)}/raw`)
    throw new Error("分层原图的持久化版本尚未确认，请重新读取素材；未使用输出图层代替原图。");
  return material;
}
