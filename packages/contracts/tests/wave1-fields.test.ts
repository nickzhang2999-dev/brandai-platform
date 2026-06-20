/**
 * Wave-1 schema additions: /v1/describe, Asset lifecycle wire fields, the K7
 * `source`/`sourceHint` SSRF hints, and K5 actual-size echo. These pin the
 * shapes the AI service + web BFF + frontend now agree on.
 */
import { describe, expect, it } from "vitest";
import {
  Asset,
  AssetSourceHint,
  DescribeRequest,
  DescribeResponse,
  GenerateResponse,
  RecognizeRequest,
  ReferenceImage,
} from "../src/index";

describe("E9/E10 · DescribeRequest/Response", () => {
  it("accepts a minimal request (url only)", () => {
    expect(DescribeRequest.safeParse({ url: "http://x/y.png" }).success).toBe(
      true,
    );
  });

  it("accepts category / brandTone / source hints", () => {
    const r = DescribeRequest.safeParse({
      url: "http://x/y.png",
      category: "PRODUCT",
      brandTone: "克制质感",
      source: "UPLOAD",
    });
    expect(r.success).toBe(true);
  });

  it("DescribeResponse requires aiDescription, defaults aiTags to []", () => {
    const r = DescribeResponse.parse({ aiDescription: "一段描述" });
    expect(r.aiTags).toEqual([]);
    // aiDescription is required (no-null contract — never optional/null).
    expect(DescribeResponse.safeParse({ aiTags: ["x"] }).success).toBe(false);
  });

  it("rejects an explicit null aiDescription (the bug shape)", () => {
    expect(
      DescribeResponse.safeParse({ aiTags: [], aiDescription: null }).success,
    ).toBe(false);
  });
});

describe("P1.3 · Asset lifecycle wire fields", () => {
  const base = {
    id: "a1",
    workspaceId: "w1",
    category: "PRODUCT",
    fileName: "x.png",
    url: "http://x/y.png",
    mimeType: "image/png",
    sizeBytes: 10,
    source: "UPLOAD",
    createdAt: "2026-06-20T00:00:00.000Z",
  };

  it("parses with lifecycle fields present", () => {
    const r = Asset.safeParse({
      ...base,
      availableForGeneration: false,
      deprecatedAt: "2026-06-20T00:00:00.000Z",
      replacementAssetId: "a2",
    });
    expect(r.success).toBe(true);
  });

  it("lifecycle fields are optional (omitted, legacy rows)", () => {
    expect(Asset.safeParse(base).success).toBe(true);
  });

  it("rejects null on the optional lifecycle fields", () => {
    expect(
      Asset.safeParse({ ...base, deprecatedAt: null }).success,
    ).toBe(false);
  });
});

describe("K7 · SSRF source hints", () => {
  it("AssetSourceHint is UPLOAD | WEBSITE", () => {
    expect(AssetSourceHint.safeParse("WEBSITE").success).toBe(true);
    expect(AssetSourceHint.safeParse("UPLOAD").success).toBe(true);
    expect(AssetSourceHint.safeParse("OTHER").success).toBe(false);
  });

  it("RecognizeRequest asset accepts an optional source hint", () => {
    expect(
      RecognizeRequest.safeParse({
        assets: [{ id: "a1", url: "http://x/y.png", source: "WEBSITE" }],
      }).success,
    ).toBe(true);
  });

  it("ReferenceImage accepts an optional sourceHint", () => {
    expect(
      ReferenceImage.safeParse({
        url: "http://x/y.png",
        polarity: "positive",
        source: "asset:a1",
        sourceHint: "WEBSITE",
      }).success,
    ).toBe(true);
  });
});

describe("K5 · GenerateResponse actual size echo", () => {
  it("accepts actualWidth/actualHeight on a version", () => {
    const r = GenerateResponse.safeParse({
      versions: [
        {
          imageUrl: "http://x/y.png",
          width: 1920,
          height: 1080,
          actualWidth: 1536,
          actualHeight: 1024,
          params: {},
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("actual size is optional (absent when undecodable / mock)", () => {
    const r = GenerateResponse.safeParse({
      versions: [
        { imageUrl: "http://x/y.png", width: 1024, height: 1024, params: {} },
      ],
    });
    expect(r.success).toBe(true);
  });
});
