/**
 * V0.0.13 — 对话面板（AI 设计师）契约：图生图 / 多图生图 + 展示层与模型层分离。
 *
 * 迁移自 prd_agent，但锁死其两个 bug 的规避策略：
 *  1. 多图不走独立 Vision 分支 → imageInputs 统一折成 STRICT referenceImages
 *     （同一条 /images/edits 路径），contracts 只需保证 ≤8、有序、类型明确；
 *  2. 用户可见文本(chatDisplayText)与模型 prompt 彻底分离 —— chatContext
 *     原样往返，schema 层不存在任何"把引用图拼进文本"的字段。
 */
import { describe, expect, it } from "vitest";
import {
  CreateGenerationInput,
  Generation,
  GenerateRequest,
  ImageInputRef,
} from "../src/index";

const baseGeneration = {
  id: "g1",
  projectId: "p1",
  workspaceId: "w1",
  sceneType: "ECOM_MAIN",
  sellingPoint: "把两张图合成一张",
  scene: "对话面板",
  status: "SUCCEEDED",
  createdAt: "2026-07-17T00:00:00.000Z",
};

describe("ImageInputRef / CreateGenerationInput.imageInputs", () => {
  it("accepts ordered VERSION/ASSET image inputs (≤8)", () => {
    const parsed = CreateGenerationInput.parse({
      projectId: "p1",
      sceneType: "ECOM_MAIN",
      imageInputs: [
        { kind: "VERSION", id: "v1" },
        { kind: "ASSET", id: "a1" },
      ],
      chatDisplayText: "把 logo 放到海报左上角",
    });
    expect(parsed.imageInputs).toEqual([
      { kind: "VERSION", id: "v1" },
      { kind: "ASSET", id: "a1" },
    ]);
    expect(parsed.chatDisplayText).toBe("把 logo 放到海报左上角");
  });

  it("rejects more than 8 image inputs", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      kind: "VERSION" as const,
      id: `v${i}`,
    }));
    expect(() =>
      CreateGenerationInput.parse({
        projectId: "p1",
        sceneType: "ECOM_MAIN",
        imageInputs: nine,
      }),
    ).toThrow();
  });

  it("rejects unknown input kinds", () => {
    expect(() => ImageInputRef.parse({ kind: "FILE", id: "x" })).toThrow();
  });

  it("keeps the legacy payload shape unchanged (frozen-additive)", () => {
    const parsed = CreateGenerationInput.parse({
      projectId: "p1",
      sceneType: "ECOM_MAIN",
    });
    expect(parsed.imageInputs).toBeUndefined();
    expect(parsed.chatDisplayText).toBeUndefined();
  });
});

describe("Generation.chatContext（会话流投影，无消息表）", () => {
  it("round-trips displayText + imageInputs verbatim", () => {
    const parsed = Generation.parse({
      ...baseGeneration,
      chatContext: {
        displayText: "把 logo 放到海报左上角",
        imageInputs: [
          { kind: "VERSION", id: "v1", url: "https://cdn/v1.png" },
          { kind: "ASSET", id: "a1", url: "https://cdn/a1.png" },
        ],
      },
    });
    expect(parsed.chatContext?.displayText).toBe("把 logo 放到海报左上角");
    expect(parsed.chatContext?.imageInputs).toHaveLength(2);
    // 展示文本绝不被自动拼接：schema 原样往返，不存在文件名/URL 注入点。
    expect(parsed.chatContext?.displayText).not.toContain("http");
    expect(parsed.chatContext?.displayText).not.toContain(".png");
  });

  it("stays optional for pre-V0.0.13 rows", () => {
    const parsed = Generation.parse(baseGeneration);
    expect(parsed.chatContext).toBeUndefined();
  });
});

describe("GenerateRequest.systemPrompt", () => {
  it("accepts the admin-configured system prompt", () => {
    const parsed = GenerateRequest.parse({
      sceneType: "ECOM_MAIN",
      sellingPoint: "x",
      scene: "y",
      brandRules: [],
      systemPrompt: "品牌基调：极简。",
    });
    expect(parsed.systemPrompt).toBe("品牌基调：极简。");
  });

  it("stays absent by default (frozen-additive)", () => {
    const parsed = GenerateRequest.parse({
      sceneType: "ECOM_MAIN",
      sellingPoint: "x",
      scene: "y",
      brandRules: [],
    });
    expect(parsed.systemPrompt).toBeUndefined();
  });
});
