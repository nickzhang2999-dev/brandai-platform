import { describe, expect, it } from "vitest";
import {
  GENERATION_SCENE_MAX_LENGTH,
  GENERATION_SELLING_POINT_MAX_LENGTH,
  getSceneTypeLabel,
  resolveGenerationDefaults,
} from "../src/generation-defaults";

describe("resolveGenerationDefaults", () => {
  it("preserves user-provided sellingPoint and scene", () => {
    const resolved = resolveGenerationDefaults({
      sceneType: "SOCIAL_POSTER",
      sellingPoint: " 用户卖点 ",
      scene: " 用户场景 ",
      project: {
        name: "夏季活动",
        aiSummary: "项目摘要",
        channel: "小红书",
      },
      brand: { name: "LUMINA", industry: "护肤" },
    });

    expect(resolved).toEqual({
      sellingPoint: "用户卖点",
      scene: "用户场景",
      sellingPointSource: "user",
      sceneSource: "user",
    });
  });

  it("fills both fields from deterministic project and brand context", () => {
    const resolved = resolveGenerationDefaults({
      sceneType: "ECOM_MAIN",
      sellingPoint: "",
      scene: "",
      project: {
        name: "新品项目",
        product: "精华水",
        campaign: "夏季新品",
        channel: "天猫",
        channels: ["小红书", "天猫"],
      },
      brand: { name: "LUMINA", industry: "护肤" },
    });

    expect(resolved.sellingPoint).toBe(
      "为「LUMINA」生成电商主图，围绕精华水，突出护肤行业调性、清晰卖点与可商用的视觉质感。",
    );
    expect(resolved.scene).toBe("适合天猫、小红书投放的夏季新品电商主图场景");
    expect(resolved.sellingPointSource).toBe("system");
    expect(resolved.sceneSource).toBe("system");
  });

  it("prefers project aiSummary and description before generated brief text", () => {
    expect(
      resolveGenerationDefaults({
        sceneType: "SELLING_POINT",
        project: {
          aiSummary: "AI 摘要文案",
          description: "项目描述文案",
        },
      }).sellingPoint,
    ).toBe("AI 摘要文案");

    expect(
      resolveGenerationDefaults({
        sceneType: "SELLING_POINT",
        project: {
          description: "项目描述文案",
        },
      }).sellingPoint,
    ).toBe("项目描述文案");
  });

  it("truncates resolved values to safe backend lengths", () => {
    const resolved = resolveGenerationDefaults({
      sceneType: "CAMPAIGN_KV",
      sellingPoint: "卖".repeat(GENERATION_SELLING_POINT_MAX_LENGTH + 5),
      scene: "场".repeat(GENERATION_SCENE_MAX_LENGTH + 5),
    });

    expect(resolved.sellingPoint).toHaveLength(
      GENERATION_SELLING_POINT_MAX_LENGTH,
    );
    expect(resolved.scene).toHaveLength(GENERATION_SCENE_MAX_LENGTH);
  });
});

describe("getSceneTypeLabel", () => {
  it("maps known scene types and keeps unknown custom labels usable", () => {
    expect(getSceneTypeLabel("SOCIAL_POSTER")).toBe("社交海报");
    expect(getSceneTypeLabel("CUSTOM")).toBe("CUSTOM");
    expect(getSceneTypeLabel("")).toBe("视觉物料");
  });
});
