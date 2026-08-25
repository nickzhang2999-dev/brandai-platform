/**
 * 图层组的共享判据。
 *
 * 放在 contracts 而不是 apps/web 是有意的:这几条判断会被 worker（落库时）、
 * BFF（读回时）和前端（渲染/导出时）同时用到,抄成三份必然各自漂移。prd_agent
 * 就是把层序判断分成了"渲染按 layerZ 排"和"导出按数组序取"两份,于是用户调过
 * 层序之后导出的 PSD 与画布对不上,而那行代码上方还写着一句"顺序天然一致"
 * 把洞保护起来。这里让后来者没有第二个口径可走偏。
 */

/** 实墨阈值:alpha ≥ 64（约 25% 不透明度）才算"看得见的墨"。 */
export const INK_ALPHA_THRESHOLD = 64;

/**
 * 细层标记线（实墨覆盖率）。**这是标记，不是"空层"判据。**
 *
 * 2026-08-25 真上游实测:一张主视觉拆 4 层,第四层是那组绿色取景框角标——真实
 * 设计元素,实墨覆盖率只有 0.12%。prd_agent 的空层线是 0.2% 且**默认隐藏**判空的
 * 层,这一层会被藏起来,用户以为模型没拆出来。
 *
 * 细线、描边、角标天然低覆盖率,纯覆盖率阈值判不了"空"。所以本仓库只标记、
 * 不隐藏:`layerHidden` 永远由用户决定。
 */
export const THIN_INK_COVERAGE_MAX = 0.005;

/** 实测参照值:那组绿色取景框角标的实墨覆盖率。守卫测试拿它当固定样本。 */
export const MEASURED_THIN_ACCENT_COVERAGE = 0.0012;

export function isThinCoverage(inkCoverage: number): boolean {
  return inkCoverage > 0 && inkCoverage <= THIN_INK_COVERAGE_MAX;
}

export interface LayerOrderKey {
  /** 叠放次序,越大越靠上。 */
  z: number;
  /** 分解时的原始序号,层序未被调整过时等于 z。 */
  index: number;
}

/** 唯一的层序口径:先 z,再 index。渲染 / 面板 / 导出全部读它。 */
export function compareLayerOrder(a: LayerOrderKey, b: LayerOrderKey): number {
  if (a.z !== b.z) return a.z - b.z;
  return a.index - b.index;
}

export function sortLayers<T extends LayerOrderKey>(layers: readonly T[]): T[] {
  return [...layers].sort(compareLayerOrder);
}

/**
 * 一组图层能不能导出成分层文档。
 *
 * 判据刻意比"有没有可见层"宽:分层文档**有意保留隐藏层**（写进去并标记隐藏）,
 * 所以"把所有眼睛都关掉"是完全合法的状态,此时合成 PNG 确实是空图、打包也没
 * 东西可打,但分层文档仍然是一份完整可编辑的产物。prd_agent 三个导出出口共用
 * 了同一个 `visibleCount === 0` 开关,于是把唯一仍然成立的那个出口也禁掉了。
 */
export function canExportLayeredDocument(
  layers: readonly { imageUrl?: string }[],
): boolean {
  return layers.some((layer) => !!layer.imageUrl);
}

/** 合成 PNG / 打包导出才需要"至少有一层可见"。 */
export function canExportFlattened(
  layers: readonly { hidden: boolean; imageUrl?: string }[],
): boolean {
  return layers.some((layer) => !layer.hidden && !!layer.imageUrl);
}
