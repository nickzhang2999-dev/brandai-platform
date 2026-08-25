import sharp from "sharp";
import {
  INK_ALPHA_THRESHOLD,
  compareLayerOrder,
  isThinCoverage,
} from "@brandai/contracts";
import type { LayerBounds, LayerSetView, LayerView } from "@brandai/contracts";

/**
 * 图层分解的服务端产物处理:实墨包围盒 + 覆盖率 + 图层组读写。
 *
 * 为什么放服务端(而不是照搬 prd_agent 的浏览器实现):
 *
 * 1. 那边在浏览器里读像素,长期和跨域读像素被拦搏斗——而伪造 CORS 响应头会
 *    把真实故障整个藏起来,所以那条路只能一直忍着。这里 worker 直接拿到字节,
 *    根本不存在跨域这回事。
 * 2. 那边的裁剪结果靠画布防抖落盘,出过"刷新后某一层退回满幅"的竞态。这里
 *    包围盒在产物落库的同一笔事务里算完写死,没有第二个时刻可以丢。
 * 3. 层序/显隐只有服务端一个口径,导出与面板不可能各排各的(prd_agent 的
 *    多选导出层序与面板不一致,正是两个口径漂移出来的)。
 */

// 实墨阈值与细层标记线都来自 contracts 的共享判据,这里不另立一份。
export interface LayerAnalysis {
  width: number;
  height: number;
  /** 实墨包围盒;整层无实墨时为 undefined。 */
  bounds?: LayerBounds;
  /** 实墨像素占全幅比例,0–1。 */
  inkCoverage: number;
  thin: boolean;
}

/**
 * 扫一遍 alpha 通道,同时算出实墨包围盒与覆盖率。
 *
 * 一次扫描出两个量是有意的:分成两趟就有两处判据,迟早漂移(prd_agent 的
 * 空层判定与裁剪判定就分别演化过)。
 */
export async function analyzeLayerImage(input: Buffer): Promise<LayerAnalysis> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const total = width * height;
  if (total <= 0) {
    return { width, height, inkCoverage: 0, thin: true };
  }

  let ink = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * channels;
    for (let x = 0; x < width; x++) {
      const alpha = data[rowStart + x * channels + (channels - 1)] ?? 0;
      if (alpha < INK_ALPHA_THRESHOLD) continue;
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const inkCoverage = ink / total;
  const bounds: LayerBounds | undefined =
    maxX >= minX && maxY >= minY
      ? {
          left: minX,
          top: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        }
      : undefined;

  return {
    width,
    height,
    ...(bounds ? { bounds } : {}),
    inkCoverage,
    thin: isThinCoverage(inkCoverage),
  };
}

/* ------------------------------------------------------------------ *
 * 图层组在 GenerationVersion.params 里的形状（方案 A）
 * ------------------------------------------------------------------ */

export interface LayerParams {
  layerRole: "layer";
  layerSetId: string;
  layerIndex: number;
  layerHidden: boolean;
  layerOpacity: number;
  layerZ: number;
  layerBounds?: LayerBounds;
  layerInkCoverage: number;
  layerThin: boolean;
}

export interface DecomposeStamp {
  sourceVersionId: string;
  requestedLayerCount: number;
  intent?: string;
  seed?: number;
  provider?: string;
  decomposedAt: string;
}

type VersionRow = {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
  params: unknown;
  createdAt: Date;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 某个版本是不是分解出来的图层（而不是普通出图 / 改图子版本）。 */
export function isLayerVersion(params: unknown, setId?: string): boolean {
  const p = asRecord(params);
  if (p.layerRole !== "layer") return false;
  if (!setId) return true;
  return p.layerSetId === setId;
}

export function serializeLayerSet(
  setId: string,
  generationId: string,
  rows: VersionRow[],
): LayerSetView | null {
  const layers: LayerView[] = [];
  let stamp: DecomposeStamp | null = null;

  for (const row of rows) {
    const p = asRecord(row.params);
    if (!isLayerVersion(p, setId)) continue;
    const decompose = asRecord(p.decompose);
    if (!stamp && typeof decompose.sourceVersionId === "string") {
      stamp = {
        sourceVersionId: decompose.sourceVersionId,
        requestedLayerCount: num(decompose.requestedLayerCount, rows.length),
        ...(typeof decompose.intent === "string" && decompose.intent
          ? { intent: decompose.intent }
          : {}),
        ...(typeof decompose.seed === "number"
          ? { seed: decompose.seed }
          : {}),
        ...(typeof decompose.provider === "string"
          ? { provider: decompose.provider }
          : {}),
        decomposedAt:
          typeof decompose.decomposedAt === "string"
            ? decompose.decomposedAt
            : row.createdAt.toISOString(),
      };
    }
    const index = num(p.layerIndex, layers.length);
    const bounds = asRecord(p.layerBounds);
    layers.push({
      versionId: row.id,
      index,
      imageUrl: row.imageUrl,
      width: row.width,
      height: row.height,
      ...(typeof bounds.width === "number" && typeof bounds.height === "number"
        ? {
            bounds: {
              left: num(bounds.left, 0),
              top: num(bounds.top, 0),
              width: bounds.width,
              height: bounds.height,
            },
          }
        : {}),
      inkCoverage: num(p.layerInkCoverage, 0),
      thin: p.layerThin === true,
      hidden: p.layerHidden === true,
      opacity: num(p.layerOpacity, 1),
      z: num(p.layerZ, index),
    });
  }

  if (layers.length === 0 || !stamp) return null;
  layers.sort(compareLayerOrder);

  return {
    setId,
    generationId,
    sourceVersionId: stamp.sourceVersionId,
    requestedLayerCount: stamp.requestedLayerCount,
    ...(stamp.intent ? { intent: stamp.intent } : {}),
    ...(stamp.seed !== undefined ? { seed: stamp.seed } : {}),
    ...(stamp.provider ? { provider: stamp.provider } : {}),
    createdAt: stamp.decomposedAt,
    layers,
  };
}
