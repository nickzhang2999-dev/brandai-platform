import { z } from "zod";

// V0.0.13d — 工作台开放画布持久化契约（对齐 prd_agent image_master_canvases 语义）。
// 只存「可编辑结构化状态」：元素引用 + 布局 + 相机 + 已删版本集。
// 图片字节永不入画布 JSON —— image 项的 imageUrl 必须是可持久引用
// （https/同源代理路径），data:/blob: 本地内容一律拒绝（上传先走 Asset 存储换 URL）。

/** 持久化元素上限（对齐 prd_agent MAX_PERSIST_ELEMENTS=200）。 */
export const CANVAS_MAX_ITEMS = 200;

const persistableUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (u) => !u.startsWith("data:") && !u.startsWith("blob:"),
    "图片字节不入画布 JSON（data:/blob: 需先持久化为资产 URL）",
  );

const itemBase = {
  key: z.string().min(1).max(64),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
};

export const CanvasImageItemSchema = z.object({
  ...itemBase,
  kind: z.literal("image"),
  imageUrl: persistableUrl,
  /** 出图变体 tile 来源（有则参与 seedVersions 同步/裁剪）。 */
  versionId: z.string().optional(),
  /** 上传/素材图来源（可被对话面板引用为 ASSET 图像输入）。 */
  assetId: z.string().optional(),
  naturalW: z.number().optional(),
  naturalH: z.number().optional(),
  /**
   * 图层分解元数据（frozen-additive，全部可选 → 既有画布负载原样通过）。
   *
   * `layerSetId` 说「这块是哪一次分解的产物」（产物血缘，解组不该抹掉）；
   * `groupId` 说「这些东西现在被框在一起」（用户的组织意图，随时可改）。
   * 落地时两者初值相同，之后各走各的——这一条是从 prd_agent 直接搬来的，
   * 那边把两个语义混用过一次，导致「解组」在刷新后被静默撤销。
   *
   * 摆位/显隐/层序**不在这里**：它们是服务端权威的，读 layer-sets 接口，
   * 不进画布 JSON，否则又会出现两份事实源。
   */
  layerSetId: z.string().max(64).optional(),
  layerIndex: z.number().int().nonnegative().optional(),
  layerRole: z.enum(["source", "layer"]).optional(),
  groupId: z.string().max(64).optional(),
});

export const CanvasShapeItemSchema = z.object({
  ...itemBase,
  kind: z.literal("shape"),
  shapeType: z.enum(["rect", "circle", "triangle", "star"]),
  fill: z.string().max(64),
  stroke: z.string().max(64),
});

export const CanvasTextItemSchema = z.object({
  ...itemBase,
  kind: z.literal("text"),
  text: z.string().max(2000),
  fontSize: z.number(),
  color: z.string().max(64),
});

export const CanvasItemSchema = z.discriminatedUnion("kind", [
  CanvasImageItemSchema,
  CanvasShapeItemSchema,
  CanvasTextItemSchema,
]);
export type CanvasItemWire = z.infer<typeof CanvasItemSchema>;

export const CanvasCameraSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().min(0.01).max(10),
});

export const CanvasStateSchema = z.object({
  items: z.array(CanvasItemSchema).max(CANVAS_MAX_ITEMS).default([]),
  camera: CanvasCameraSchema.optional(),
  removedVersionIds: z.array(z.string()).max(500).default([]),
});
export type CanvasState = z.infer<typeof CanvasStateSchema>;

/** PUT body = 整份状态（服务端 last-writer-wins，对齐 prd_agent 已知取舍）。 */
export const UpsertCanvasInputSchema = CanvasStateSchema;
export type UpsertCanvasInput = z.infer<typeof UpsertCanvasInputSchema>;
