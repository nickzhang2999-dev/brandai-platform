import { describe, expect, it } from "vitest";
import {
  CanvasItemSchema,
  CanvasStateSchema,
  UpsertCanvasInputSchema,
} from "../src/canvas";

// V0.0.13d — 画布服务端持久化契约（对齐 prd_agent image_master_canvases 语义：
// 只存引用与布局，不存图片字节；恢复端按 200 元素截断）。

describe("CanvasItemSchema", () => {
  it("image 项：接受 versionId 出图 tile 与 assetId 上传图", () => {
    const versionTile = CanvasItemSchema.parse({
      key: "v-abc",
      kind: "image",
      x: 10,
      y: 20,
      w: 300,
      h: 400,
      imageUrl: "https://cdn.example.com/a.png",
      versionId: "ver1",
      naturalW: 1024,
      naturalH: 1536,
    });
    expect(versionTile.kind).toBe("image");
    const uploaded = CanvasItemSchema.parse({
      key: "asset-1",
      kind: "image",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      imageUrl: "/api/workspaces/w/assets/a1/raw",
      assetId: "a1",
    });
    expect(uploaded.assetId).toBe("a1");
  });

  it("拒绝 data:URL 进持久化（字节不入画布 JSON）", () => {
    expect(() =>
      CanvasItemSchema.parse({
        key: "k",
        kind: "image",
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        imageUrl: "data:image/png;base64,AAAA",
      }),
    ).toThrow();
  });

  it("shape / text 项字段完整往返", () => {
    const shape = CanvasItemSchema.parse({
      key: "shape-1",
      kind: "shape",
      x: 1,
      y: 2,
      w: 50,
      h: 60,
      shapeType: "circle",
      fill: "#EDE9FE",
      stroke: "#7C5CFF",
    });
    expect(shape.shapeType).toBe("circle");
    const text = CanvasItemSchema.parse({
      key: "text-1",
      kind: "text",
      x: 0,
      y: 0,
      w: 200,
      h: 40,
      text: "双十一主视觉",
      fontSize: 28,
      color: "#1A1523",
    });
    expect(text.text).toContain("双十一");
  });
});

describe("CanvasStateSchema", () => {
  it("完整状态往返（items + camera + removedVersionIds）", () => {
    const state = CanvasStateSchema.parse({
      items: [
        {
          key: "v-1",
          kind: "image",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          imageUrl: "https://cdn.example.com/x.png",
          versionId: "ver1",
        },
      ],
      camera: { x: 120, y: 80, zoom: 0.8 },
      removedVersionIds: ["gone1"],
    });
    expect(state.items).toHaveLength(1);
    expect(state.camera?.zoom).toBe(0.8);
    expect(state.removedVersionIds).toEqual(["gone1"]);
  });

  it("空态默认值（items/removedVersionIds 缺省为空数组）", () => {
    const state = CanvasStateSchema.parse({});
    expect(state.items).toEqual([]);
    expect(state.removedVersionIds).toEqual([]);
    expect(state.camera).toBeUndefined();
  });

  it("元素数量上限 200（对齐 prd_agent MAX_PERSIST_ELEMENTS）", () => {
    const mk = (i: number) => ({
      key: `shape-${i}`,
      kind: "shape" as const,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      shapeType: "rect" as const,
      fill: "#fff",
      stroke: "#000",
    });
    expect(() =>
      CanvasStateSchema.parse({
        items: Array.from({ length: 201 }, (_, i) => mk(i)),
      }),
    ).toThrow();
    expect(
      CanvasStateSchema.parse({
        items: Array.from({ length: 200 }, (_, i) => mk(i)),
      }).items,
    ).toHaveLength(200);
  });
});

describe("UpsertCanvasInputSchema", () => {
  it("与读取形状一致（PUT 即整份状态）", () => {
    const body = UpsertCanvasInputSchema.parse({
      items: [],
      camera: { x: 0, y: 0, zoom: 1 },
      removedVersionIds: [],
    });
    expect(body.camera?.zoom).toBe(1);
  });
});
