/**
 * B2/C8 — SummarizeRequest/Response contract. Pins the null-vs-optional
 * boundary (the AI service runs response_model_exclude_none, so unset optionals
 * must be OMITTED, never null) and the mode/sceneType enums.
 */
import { describe, expect, it } from "vitest";
import { SummarizeRequest, SummarizeResponse } from "../src/index";

describe("SummarizeRequest", () => {
  it("accepts brief_decompose with just mode + text", () => {
    expect(
      SummarizeRequest.safeParse({ mode: "brief_decompose", text: "做一组主视觉" })
        .success,
    ).toBe(true);
  });

  it("accepts campaign_summary with context", () => {
    expect(
      SummarizeRequest.safeParse({
        mode: "campaign_summary",
        text: "夏季新品",
        context: { campaignName: "夏季新品", ruleSummaries: ["主色 #7C5CFF"] },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(
      SummarizeRequest.safeParse({ mode: "translate", text: "x" }).success,
    ).toBe(false);
  });
});

describe("SummarizeResponse — null ⊥ optional", () => {
  it("an omitted optional is valid; arrays default to []", () => {
    const r = SummarizeResponse.parse({ summary: "ok" });
    expect(r.styleKeywords).toEqual([]);
    expect(r.highlights).toEqual([]);
    expect(r.sellingPoint).toBeUndefined();
  });

  it("an explicit null on an optional field is INVALID (the bug shape)", () => {
    expect(
      SummarizeResponse.safeParse({
        sellingPoint: null,
        scene: null,
        sceneType: null,
        summary: null,
      }).success,
    ).toBe(false);
  });

  it("a full brief_decompose shape round-trips", () => {
    const r = SummarizeResponse.parse({
      sellingPoint: "清透水光",
      scene: "夏日自然光",
      sceneType: "SOCIAL_POSTER",
      styleKeywords: ["清透", "高级感"],
      summary: "小红书种草主视觉",
    });
    expect(r.sceneType).toBe("SOCIAL_POSTER");
  });

  it("rejects an invalid sceneType", () => {
    expect(
      SummarizeResponse.safeParse({ sceneType: "POSTER" }).success,
    ).toBe(false);
  });
});
