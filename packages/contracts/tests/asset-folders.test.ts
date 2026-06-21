/**
 * E3 · 素材文件夹（AssetFolder）契约 + Asset.folderId。Web-only（AI 服务不消费
 * folder），但仍走 L1 no-null/optional 边界守护：folderId 省略而非 null。
 */
import { describe, expect, it } from "vitest";
import { Asset, AssetFolder, CreateAssetFolderInput } from "../src/index";

const baseAsset = {
  id: "a1",
  workspaceId: "w1",
  category: "PRODUCT" as const,
  fileName: "x.png",
  url: "http://x/y.png",
  mimeType: "image/png",
  sizeBytes: 10,
  source: "UPLOAD" as const,
  createdAt: "2026-06-21T00:00:00.000Z",
};

describe("E3 · Asset.folderId", () => {
  it("accepts an asset filed into a folder", () => {
    expect(Asset.safeParse({ ...baseAsset, folderId: "f1" }).success).toBe(true);
  });

  it("folderId is optional (omitted = un-filed)", () => {
    expect(Asset.safeParse(baseAsset).success).toBe(true);
  });

  it("rejects an explicit null folderId (no-null wire invariant)", () => {
    expect(Asset.safeParse({ ...baseAsset, folderId: null }).success).toBe(
      false,
    );
  });
});

describe("E3 · AssetFolder", () => {
  it("parses a folder with an assetCount", () => {
    const r = AssetFolder.safeParse({
      id: "f1",
      workspaceId: "w1",
      name: "夏季新品",
      createdAt: "2026-06-21T00:00:00.000Z",
      assetCount: 3,
    });
    expect(r.success).toBe(true);
  });

  it("assetCount is optional", () => {
    expect(
      AssetFolder.safeParse({
        id: "f1",
        workspaceId: "w1",
        name: "夏季新品",
        createdAt: "2026-06-21T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("requires a name", () => {
    expect(
      AssetFolder.safeParse({
        id: "f1",
        workspaceId: "w1",
        createdAt: "2026-06-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("E3 · CreateAssetFolderInput", () => {
  it("accepts a non-empty name", () => {
    expect(CreateAssetFolderInput.safeParse({ name: "新文件夹" }).success).toBe(
      true,
    );
  });

  it("rejects an empty name", () => {
    expect(CreateAssetFolderInput.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects a name over 60 chars", () => {
    expect(
      CreateAssetFolderInput.safeParse({ name: "x".repeat(61) }).success,
    ).toBe(false);
  });
});
