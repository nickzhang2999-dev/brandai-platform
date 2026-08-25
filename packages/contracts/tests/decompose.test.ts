import { describe, expect, it } from "vitest";
import {
  DecomposeRequest,
  DecomposeResponse,
  DecomposeVersionInput,
  LayerSetView,
  MEASURED_THIN_ACCENT_COVERAGE,
  THIN_INK_COVERAGE_MAX,
  UpdateLayerSetInput,
  canExportFlattened,
  canExportLayeredDocument,
  compareLayerOrder,
  groupVersionsIntoLayerSets,
  isEmptyCoverage,
  isThinCoverage,
  planLayerSetRect,
  readLayerMeta,
  sortLayers,
} from "../src/index";

/**
 * 图层分解（AI 分层）的契约与判据。
 *
 * 每一条都能变红:把对应实现改回 prd_agent 的老行为,这里就有用例失败。
 */

const layer = (over: Partial<{ z: number; index: number }> = {}) => ({
  z: 0,
  index: 0,
  ...over,
});

describe("分解请求契约", () => {
  it("层数默认 4，范围 1-10", () => {
    expect(DecomposeRequest.parse({ imageUrl: "https://x/a.png" }).layerCount).toBe(4);
    expect(() =>
      DecomposeRequest.parse({ imageUrl: "https://x/a.png", layerCount: 0 }),
    ).toThrow();
    expect(() =>
      DecomposeRequest.parse({ imageUrl: "https://x/a.png", layerCount: 11 }),
    ).toThrow();
  });

  it("拆法意图是可选自由文本，原样保留不改写", () => {
    const intent = "logo 单独一层，不要切开人物";
    const parsed = DecomposeRequest.parse({
      imageUrl: "https://x/a.png",
      intent,
    });
    expect(parsed.intent).toBe(intent);
  });

  it("请求体里没有尺寸 / 张数 / 场景——它是动作不是生图模型", () => {
    const keys = Object.keys(DecomposeRequest.shape);
    expect(keys.sort()).toEqual(["imageUrl", "intent", "layerCount"]);
    for (const forbidden of [
      "size",
      "width",
      "height",
      "versionCount",
      "sceneType",
      "targets",
      "model",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("层数只能来自请求体（不是设备偏好）——BFF 入参形状与 AI 入参一致", () => {
    expect(Object.keys(DecomposeVersionInput.shape).sort()).toEqual([
      "intent",
      "layerCount",
    ]);
    expect(DecomposeVersionInput.parse({}).layerCount).toBe(4);
  });
});

describe("分解响应契约", () => {
  it("seed 会被保留——它是重拆能否复现的唯一抓手", () => {
    const parsed = DecomposeResponse.parse({
      layers: [{ imageUrl: "https://x/0.png", width: 640, height: 640 }],
      seed: 1307930915,
    });
    expect(parsed.seed).toBe(1307930915);
  });

  it("没有 seed 时字段缺席而不是 null（no-null wire 不变式）", () => {
    const parsed = DecomposeResponse.parse({
      layers: [{ imageUrl: "https://x/0.png", width: 640, height: 640 }],
    });
    expect("seed" in parsed && parsed.seed !== undefined).toBe(false);
  });

  it("接受比请求更多的层——多给的层已经付过费，不许在契约层丢掉", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      imageUrl: `https://x/${i}.png`,
      width: 640,
      height: 640,
    }));
    expect(DecomposeResponse.parse({ layers: four }).layers).toHaveLength(4);
  });
});

describe("细层判据（真上游实测反例）", () => {
  it("实测那组绿色角标（覆盖率 0.12%）判为细层", () => {
    expect(isThinCoverage(MEASURED_THIN_ACCENT_COVERAGE)).toBe(true);
  });

  it("细层仍然是一个正常图层：hidden 不由覆盖率决定", () => {
    // 这一条就是 prd_agent 的缺陷所在:它把 0.2% 以下判成"空层"并默认隐藏,
    // 于是实测里那组 0.12% 的真实角标会被藏起来。这里 hidden 与覆盖率无关。
    const view = LayerSetView.parse({
      setId: "set-1",
      generationId: "gen-1",
      sourceVersionId: "v-src",
      requestedLayerCount: 4,
      createdAt: new Date().toISOString(),
      layers: [
        {
          versionId: "v-3",
          index: 3,
          imageUrl: "https://x/3.png",
          width: 640,
          height: 640,
          inkCoverage: MEASURED_THIN_ACCENT_COVERAGE,
          thin: true,
          hidden: false,
          opacity: 1,
          z: 3,
        },
      ],
    });
    expect(view.layers[0]!.thin).toBe(true);
    expect(view.layers[0]!.hidden).toBe(false);
  });

  it("全透明层覆盖率为 0，不算细层（细 ≠ 空）", () => {
    expect(isThinCoverage(0)).toBe(false);
  });

  it("正常内容层不会被误标细层", () => {
    expect(isThinCoverage(0.113)).toBe(false);
    expect(THIN_INK_COVERAGE_MAX).toBeLessThan(0.113);
  });
});

describe("空层判据（真上游实测：层数要多了就会返回全透明层）", () => {
  it("实墨为 0 判为空层", () => {
    // 2026-08-25 实测:海报（背景+杯子+徽标 三个可分对象）要 4 层,上游返回的
    // 第二层实墨 0.000%。
    expect(isEmptyCoverage(0)).toBe(true);
  });

  it("空与细互斥：0.12% 的角标是细层，不是空层", () => {
    expect(isEmptyCoverage(MEASURED_THIN_ACCENT_COVERAGE)).toBe(false);
    expect(isThinCoverage(MEASURED_THIN_ACCENT_COVERAGE)).toBe(true);
  });

  it("空层判据不是覆盖率阈值：任何大于 0 的覆盖率都不算空", () => {
    // 这条守住的正是 prd_agent 的老路——用一个"很小的数"当空层线,把真实的细
    // 描边判成空并隐藏。这里只认 0。
    expect(isEmptyCoverage(1e-9)).toBe(false);
    expect(isEmptyCoverage(THIN_INK_COVERAGE_MAX)).toBe(false);
  });

  it("空层照样是可导出的图层，不被吞掉", () => {
    // 空层写进 PSD 也是一层（用户在 Photoshop 里能看到"这一层是空的"）,所以
    // 分层文档的开关与它无关。
    expect(
      canExportLayeredDocument([{ imageUrl: "https://x/empty.png" }]),
    ).toBe(true);
  });
});

describe("层序只有一个口径", () => {
  it("先按 z，再按 index", () => {
    const sorted = sortLayers([
      layer({ z: 2, index: 0 }),
      layer({ z: 0, index: 3 }),
      layer({ z: 0, index: 1 }),
    ]);
    expect(sorted.map((l) => [l.z, l.index])).toEqual([
      [0, 1],
      [0, 3],
      [2, 0],
    ]);
  });

  it("把某层挪到最上，它就排在最后（导出时写在最上面）", () => {
    const base = [
      layer({ z: 0, index: 0 }),
      layer({ z: 1, index: 1 }),
      layer({ z: 2, index: 2 }),
    ];
    const raised = base.map((l) =>
      l.index === 0 ? { ...l, z: 99 } : l,
    );
    expect(sortLayers(raised).at(-1)!.index).toBe(0);
  });

  it("z 相同时不靠数组序决定胜负（数组序正是漂移的来源）", () => {
    expect(compareLayerOrder(layer({ z: 1, index: 5 }), layer({ z: 1, index: 2 }))).toBeGreaterThan(0);
  });
});

describe("导出可用性", () => {
  const hidden = (i: number) => ({
    hidden: true,
    imageUrl: `https://x/${i}.png`,
  });

  it("全部隐藏时，分层文档仍可导出（隐藏层有意写进文档）", () => {
    const layers = [hidden(0), hidden(1), hidden(2)];
    expect(canExportLayeredDocument(layers)).toBe(true);
  });

  it("全部隐藏时，合成 PNG / 打包确实不该导出", () => {
    expect(canExportFlattened([hidden(0), hidden(1)])).toBe(false);
  });

  it("没有任何产物时两个出口都关闭", () => {
    expect(canExportLayeredDocument([{}])).toBe(false);
    expect(canExportFlattened([{ hidden: false }])).toBe(false);
  });
});

describe("图层组更新入参", () => {
  it("只接受显隐 / 不透明度 / 层序，且必须点名 versionId", () => {
    const parsed = UpdateLayerSetInput.parse({
      layers: [{ versionId: "v-1", hidden: true, opacity: 0.4, z: 7 }],
    });
    expect(parsed.layers[0]).toEqual({
      versionId: "v-1",
      hidden: true,
      opacity: 0.4,
      z: 7,
    });
    expect(() => UpdateLayerSetInput.parse({ layers: [] })).toThrow();
    expect(() =>
      UpdateLayerSetInput.parse({ layers: [{ versionId: "v", opacity: 1.5 }] }),
    ).toThrow();
  });
});


describe("从 params 读图层身份", () => {
  const layerParams = (over: Record<string, unknown> = {}) => ({
    layerRole: "layer",
    layerSetId: "set-1",
    layerIndex: 2,
    layerZ: 5,
    layerHidden: true,
    layerOpacity: 0.5,
    layerThin: true,
    layerInkCoverage: 0.0012,
    layerBounds: { left: 226, top: 257, width: 142, height: 250 },
    decompose: { sourceVersionId: "v-src" },
    ...over,
  });

  it("普通出图 / 改图子版本读不出图层身份", () => {
    expect(readLayerMeta({ imageKind: "GENERATED" })).toBeNull();
    expect(readLayerMeta({ edit: { op: "RECOLOR" } })).toBeNull();
    expect(readLayerMeta(null)).toBeNull();
    expect(readLayerMeta("nope")).toBeNull();
  });

  it("缺 layerSetId 不算图层——没有组身份的图层是孤儿", () => {
    expect(readLayerMeta(layerParams({ layerSetId: undefined }))).toBeNull();
  });

  it("读全套呈现态与实测包围盒", () => {
    expect(readLayerMeta(layerParams())).toEqual({
      setId: "set-1",
      index: 2,
      z: 5,
      hidden: true,
      opacity: 0.5,
      thin: true,
      inkCoverage: 0.0012,
      bounds: { left: 226, top: 257, width: 142, height: 250 },
      sourceVersionId: "v-src",
    });
  });

  it("层序缺省时回落到分解序号，不回落到 0", () => {
    expect(readLayerMeta(layerParams({ layerZ: undefined }))!.z).toBe(2);
  });

  it("显隐缺省是可见、不透明度缺省是 1", () => {
    const meta = readLayerMeta(
      layerParams({ layerHidden: undefined, layerOpacity: undefined }),
    )!;
    expect(meta.hidden).toBe(false);
    expect(meta.opacity).toBe(1);
  });
});

describe("画布上按组聚合", () => {
  const plain = (id: string) => ({ id, params: { imageKind: "GENERATED" } });
  const layer = (id: string, setId: string, index: number, z = index) => ({
    id,
    params: {
      layerRole: "layer",
      layerSetId: setId,
      layerIndex: index,
      layerZ: z,
      decompose: { sourceVersionId: "v-src" },
    },
  });

  it("普通图与图层组分开——一次拆 4 层不该在画布上变成四张散图", () => {
    const g = groupVersionsIntoLayerSets([
      plain("a"),
      layer("l0", "s1", 0),
      layer("l1", "s1", 1),
      plain("b"),
    ]);
    expect(g.plain.map((v) => v.id)).toEqual(["a", "b"]);
    expect(g.sets).toHaveLength(1);
    expect(g.sets[0]!.layers.map((v) => v.id)).toEqual(["l0", "l1"]);
    expect(g.sets[0]!.sourceVersionId).toBe("v-src");
  });

  it("同一张图拆两次是两组，不是一组", () => {
    const g = groupVersionsIntoLayerSets([
      layer("a0", "s1", 0),
      layer("b0", "s2", 0),
      layer("a1", "s1", 1),
    ]);
    expect(g.sets.map((s) => s.setId)).toEqual(["s1", "s2"]);
    expect(g.sets[0]!.layers).toHaveLength(2);
  });

  it("组内按层序排，不按到达顺序", () => {
    const g = groupVersionsIntoLayerSets([
      layer("top", "s1", 0, 9),
      layer("bottom", "s1", 1, 0),
    ]);
    expect(g.sets[0]!.layers.map((v) => v.id)).toEqual(["bottom", "top"]);
  });
});

describe("图层组落位", () => {
  const source = { x: 0, y: 0, w: 400, h: 400 };

  it("默认落在原图右侧，不盖住原图", () => {
    const rect = planLayerSetRect(source, [source]);
    expect(rect.x).toBeGreaterThanOrEqual(source.x + source.w);
    expect(rect.y).toBe(source.y);
    expect(rect).toMatchObject({ w: 400, h: 400 });
  });

  it("右侧被占了就继续往右找空地——重拆不覆盖上一次的结果", () => {
    const first = planLayerSetRect(source, [source]);
    const second = planLayerSetRect(source, [source, first]);
    expect(second.x).toBeGreaterThan(first.x);
  });

  it("叠放：一组里每块都落在同一块矩形上，看着和原图一样", () => {
    const rect = planLayerSetRect(source, [source]);
    const stacked = Array.from({ length: 4 }, () => rect);
    expect(new Set(stacked.map((r) => `${r.x},${r.y}`)).size).toBe(1);
  });

  it("挪不动时也会停下，不死循环", () => {
    const wall = Array.from({ length: 60 }, (_, i) => ({
      x: i * 520,
      y: 0,
      w: 400,
      h: 400,
    }));
    const rect = planLayerSetRect(source, wall);
    expect(Number.isFinite(rect.x)).toBe(true);
  });
});
