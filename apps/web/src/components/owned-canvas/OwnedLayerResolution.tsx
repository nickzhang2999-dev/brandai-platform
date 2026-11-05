import type { DecompositionTask } from "./owned-editor-api";

/** Published pixel size is a canvas size, never a promise of recovered detail. */
export function OwnedLayerResolution({ task }: { task: DecompositionTask }) {
  const unknown = task.layers.some(layer => !layer.resolution);
  const upscaled = task.layers.some(layer => layer.resolution && (layer.resolution.scaleX > 1 || layer.resolution.scaleY > 1));
  return <div className="space-y-1 text-xs leading-5 text-muted-foreground" data-testid="owned-layer-resolution">
    <p>原图 {task.sourceWidth} × {task.sourceHeight} 像素，原图文件仍保留。</p>
    {unknown && <p>部分历史图层未记录模型输出像素，有效分辨率未知，不能按文件尺寸判断清晰度。</p>}
    {upscaled && <p>模型输出低于画布尺寸。已保留的原图像素与生成补全部分请分别核对，小字、纹理和边缘仍需放大检查。</p>}
    <details><summary className="cursor-pointer">查看图层像素记录</summary><ul className="space-y-1">{task.layers.map(layer => {
      const r = layer.resolution;
      return <li key={layer.assetId}>{layer.name || `图层 ${layer.order + 1}`}：模型 {r ? `${r.providerWidth} × ${r.providerHeight}` : "未知"} → 发布 {layer.width} × {layer.height}；倍率 {r ? `${r.scaleX.toFixed(2)} × ${r.scaleY.toFixed(2)}` : "未知"}。{r && (r.rgbSource === "SOURCE_VISIBLE" ? `已保留 ${r.sourcePixelCount} 个可见区域原图像素；遮挡补全、阴影和不确定边缘仍来自模型。` : "颜色来自模型结果，未替换为原图；同尺寸也不代表无损。")}</li>;
    })}</ul></details>
  </div>;
}
