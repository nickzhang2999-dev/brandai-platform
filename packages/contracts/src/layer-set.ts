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

/**
 * 真空层:一个实墨像素都没有。
 *
 * 2026-08-25 真上游实测:同一张海报要 4 层,画面里只有 3 个可分对象,上游就会返回
 * 一层**完全透明**的产物（实墨 0.000%）。它和"细层"是两回事——细层有内容只是很
 * 少（不能隐藏），空层是真的什么都没有。
 *
 * 判据刻意用 `=== 0` 而不是"小于某个很小的数":覆盖率阈值判空正是 prd_agent 那条
 * 把 0.12% 的角标判成空层的老路。0 就是 0,没有第二种解释。
 *
 * 空层同样**不自动隐藏**——它照样占一行、写明「空」,用户才知道"不是漏了一层,
 * 是层数要多了"。悄悄吞掉它，用户只会数出 3 层然后怀疑功能坏了。
 */
export function isEmptyCoverage(inkCoverage: number): boolean {
  return inkCoverage === 0;
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

/* ------------------------------------------------------------------ *
 * 从 GenerationVersion.params 读图层元数据
 *
 * 图层是普通的出图子版本（方案 A），身份全写在 params 里。读法只此一份：
 * worker 写、BFF 读、画布渲染、导出排序全走它，避免四处各自 `as any` 取字段。
 * ------------------------------------------------------------------ */

export interface LayerMeta {
  setId: string;
  index: number;
  z: number;
  hidden: boolean;
  opacity: number;
  thin: boolean;
  inkCoverage: number;
  bounds?: { left: number; top: number; width: number; height: number };
  sourceVersionId?: string;
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 不是分解产物时返回 null。 */
export function readLayerMeta(params: unknown): LayerMeta | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  if (p.layerRole !== "layer") return null;
  const setId = typeof p.layerSetId === "string" ? p.layerSetId : "";
  if (!setId) return null;

  const index = pickNumber(p.layerIndex, 0);
  const boundsRaw =
    p.layerBounds && typeof p.layerBounds === "object"
      ? (p.layerBounds as Record<string, unknown>)
      : null;
  const decompose =
    p.decompose && typeof p.decompose === "object"
      ? (p.decompose as Record<string, unknown>)
      : null;

  return {
    setId,
    index,
    z: pickNumber(p.layerZ, index),
    hidden: p.layerHidden === true,
    opacity: pickNumber(p.layerOpacity, 1),
    thin: p.layerThin === true,
    inkCoverage: pickNumber(p.layerInkCoverage, 0),
    ...(boundsRaw && typeof boundsRaw.width === "number"
      ? {
          bounds: {
            left: pickNumber(boundsRaw.left, 0),
            top: pickNumber(boundsRaw.top, 0),
            width: pickNumber(boundsRaw.width, 0),
            height: pickNumber(boundsRaw.height, 0),
          },
        }
      : {}),
    ...(decompose && typeof decompose.sourceVersionId === "string"
      ? { sourceVersionId: decompose.sourceVersionId }
      : {}),
  };
}

/**
 * `params` 里属于「图层身份」的那几把钥匙。
 *
 * 单列一份是因为它是**契约**:worker 写它、`readLayerMeta` 读它、layer-set 查询
 * 按 `layerSetId` 过滤、画布按 `layerSetId` 分组。任何"从一个图层派生出新版本"
 * 的链路(改图/局部重画/加水印…)都必须先把它们摘干净,否则派生出来的那一版会被
 * 当成同一组里的**第二个同序号成员**——组凭空变大,画布叠两遍,PSD/ZIP 也导两份。
 */
export const LAYER_PARAM_KEYS = [
  "layerRole",
  "layerSetId",
  "layerIndex",
  "layerZ",
  "layerHidden",
  "layerOpacity",
  "layerBounds",
  "layerInkCoverage",
  "layerThin",
  "decompose",
] as const;

/**
 * 摘掉图层身份,其余字段原样保留。
 *
 * 语义是「这一版不再属于任何图层组」,不是「这一版替换了原来那层」——替换是另一
 * 套血缘(要重算包围盒与覆盖率、要继承 z、要让原层退场),不在此处臆造。
 */
export function stripLayerMeta<T extends object>(params: T): Partial<T> {
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  for (const key of LAYER_PARAM_KEYS) delete out[key];
  return out as Partial<T>;
}

export interface VersionWithParams {
  id: string;
  params: unknown;
}

export interface GroupedVersions<T extends VersionWithParams> {
  /** 普通出图 / 改图子版本——画布按老规矩逐张平铺。 */
  plain: T[];
  /** 分解产物，按图层组聚。画布把一组当**一个对象**摆，不是 N 张散图。 */
  sets: { setId: string; sourceVersionId?: string; layers: T[] }[];
}

/**
 * 把版本列表拆成「普通图」与「图层组」。
 *
 * 不分开的话，一次拆 4 层就会在画布上凭空多出四张看不懂的散图——这正是方案 A
 * 的必配项：图层组必须以组为单位出现。
 */
export function groupVersionsIntoLayerSets<T extends VersionWithParams>(
  versions: readonly T[],
): GroupedVersions<T> {
  const plain: T[] = [];
  const order: string[] = [];
  const bySet = new Map<string, { sourceVersionId?: string; layers: T[] }>();

  for (const version of versions) {
    const meta = readLayerMeta(version.params);
    if (!meta) {
      plain.push(version);
      continue;
    }
    let bucket = bySet.get(meta.setId);
    if (!bucket) {
      bucket = {
        ...(meta.sourceVersionId ? { sourceVersionId: meta.sourceVersionId } : {}),
        layers: [],
      };
      bySet.set(meta.setId, bucket);
      order.push(meta.setId);
    }
    bucket.layers.push(version);
  }

  return {
    plain,
    sets: order.map((setId) => {
      const bucket = bySet.get(setId)!;
      const layers = [...bucket.layers].sort((a, b) => {
        const ma = readLayerMeta(a.params)!;
        const mb = readLayerMeta(b.params)!;
        return compareLayerOrder(ma, mb);
      });
      return {
        setId,
        ...(bucket.sourceVersionId
          ? { sourceVersionId: bucket.sourceVersionId }
          : {}),
        layers,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 图层组在画布上的落位
 * ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 给这一组图层挑一块空地:原图右侧、与原图等大、不压住画布上任何既有元素。
 *
 * 两条都不能省（都是 prd_agent 用真实反馈换来的）:
 * - **原图必须原封不动**。副本盖在原图上会让用户失去参照，也让"拆坏了重来"
 *   变成不可能。
 * - **同一张图拆多次要各占一块地**。第二次拆不是覆盖第一次，而是右边再多一份，
 *   两次结果并排才能比较着挑。
 *
 * 找法很朴素:从原图右侧第一格起一格一格往右挪，直到这一格不与任何既有元素相交。
 * 上限 24 格是防呆——真挪不动就落在最后一格上，宁可重叠也不能死循环。
 */
export function planLayerSetRect(
  source: Rect,
  occupied: readonly Rect[],
  gap = 120,
): Rect {
  const w = Math.max(1, Math.round(source.w));
  const h = Math.max(1, Math.round(source.h));
  const y = Math.round(source.y);
  const step = w + gap;
  const boxes = occupied.filter((b) => b.w > 0 && b.h > 0);
  const hits = (x: number) =>
    boxes.some(
      (b) => x + w > b.x && b.x + b.w > x && y + h > b.y && b.y + b.h > y,
    );

  let x = Math.round(source.x) + step;
  for (let i = 0; i < 24 && hits(x); i++) x += step;
  return { x, y, w, h };
}

/**
 * 图层组默认**叠放**（stacked）:每一块都落在同一块矩形上，叠起来看着和原图
 * 一模一样，区别只是现在每块都能单独选中、拖动。
 *
 * 不默认摊开成一排:用户多数时候只是想"把某个部件挪一点"，摊开之后他还得自己
 * 拼回去，那是倒忙。
 */
export function planStackedLayerRects(rect: Rect, count: number): Rect[] {
  return Array.from({ length: Math.max(0, count) }, () => ({ ...rect }));
}
