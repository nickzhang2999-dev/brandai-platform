import { describe, expect, it } from "vitest";
import { StudioBrandMaterialsQuery, StudioBrandMaterialOperation, StudioBrandMaterialVerification, StudioBrandMaterialsPage, StudioBrandMaterialUploadInput, StudioBrandMaterialUploadView } from "../src/studio-brand-materials";
import { studioBrandMaterialSourceDigest, studioBrandObjectKey, studioTrustedMaterial } from "../../../apps/web/src/lib/studio-brand-materials-trust";
const asset = { id: "a", workspaceId: "w", storageKey: "w/a.png", url: "https://storage.invalid/w/a.png", fileName: "image.png", mimeType: "image/png",
  sizeBytes: 123, generationVersionId: null, availableForGeneration: true, deprecatedAt: null };
const proof = { sha256: "a".repeat(64), mimeType: "image/png", width: 8, height: 6 };

describe("brand material contracts and content binding", () => {
  it("a projectless receipt has an explicit brand context and cannot leak into project upload contracts", () => {
    const mutationId = "831a0280-2cf1-41ba-ac94-621053c4a4c6";
    expect(StudioBrandMaterialUploadInput.safeParse({ mutationId }).success).toBe(true);
    expect(StudioBrandMaterialUploadInput.safeParse({ mutationId, projectId: "fake-project" }).success).toBe(false);
    expect(StudioBrandMaterialUploadView.safeParse({ context: "brand-library", workspaceId: "w", taskId: "t", mutationId, status: "PENDING", progress: 0, expiresAt: "2026-10-14T00:06:00Z" }).success).toBe(true);
    expect(StudioBrandMaterialUploadView.safeParse({ context: "brand-library", workspaceId: "w", taskId: "t", mutationId, status: "PENDING", progress: 0, expiresAt: "2026-10-14T00:06:00Z", projectId: null }).success).toBe(false);
  });
  it("bounds real keyset pages and keeps tenant identity out of request bodies", () => {
    expect(StudioBrandMaterialsQuery.parse({ search: " 商品 " })).toEqual({ search: "商品", limit: 24, libraryKind: "ALL" });
    for (const bad of [{ limit: 61 }, { limit: "24" }, { limit: 1.5 }, { search: null }, { workspaceId: "other" }, { cursor: "" }])
      expect(StudioBrandMaterialsQuery.safeParse(bad).success).toBe(false);
    expect(StudioBrandMaterialsPage.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });
  it("requires explicit verified SHA when linking, and cannot import an arbitrary URL", () => {
    expect(StudioBrandMaterialOperation.parse({ operation: "link", projectId: "p", assetSha256: proof.sha256 })).toHaveProperty("operation", "link");
    for (const bad of [{ operation: "link", projectId: "p" }, { operation: "verify", url: "http://private.invalid" }, { operation: "link", projectId: null, assetSha256: proof.sha256 }])
      expect(StudioBrandMaterialOperation.safeParse(bad).success).toBe(false);
  });
  it("never advertises a pending, failed or fabricated verification as a trusted material", () => {
    const material = studioTrustedMaterial(asset, proof)!;
    expect(material.url).toBe("/api/workspaces/w/assets/a/raw");
    expect(StudioBrandMaterialVerification.safeParse({ assetId: "a", status: "SUCCEEDED", material }).success).toBe(true);
    for (const bad of [{ assetId: "a", status: "SUCCEEDED" }, { assetId: "a", status: "PENDING", material }, { assetId: "a", status: "FAILED" }])
      expect(StudioBrandMaterialVerification.safeParse(bad).success).toBe(false);
    expect(studioTrustedMaterial({ ...asset, deprecatedAt: new Date() }, proof)).toBeNull();
    expect(studioTrustedMaterial({ ...asset, availableForGeneration: false }, proof)).toBeNull();
    expect(studioTrustedMaterial(asset, { ...proof, sha256: "fabricated" })).toBeNull();
    expect(studioTrustedMaterial(asset, { ...proof, mimeType: "image/jpeg" })).toBeNull();
    expect(studioTrustedMaterial({ ...asset, generationVersionId: "version" }, proof)?.versionId).toBe("version");
  });
  it("invalidates receipts if URL, bytes metadata, storage identity or generated version changes", () => {
    const old = studioBrandMaterialSourceDigest(asset);
    for (const changed of [{ url: "https://different.invalid/a" }, { storageKey: "w/changed.png" }, { sizeBytes: 200 }, { generationVersionId: "v2" }, { workspaceId: "other" }])
      expect(studioBrandMaterialSourceDigest({ ...asset, ...changed })).not.toBe(old);
    expect(studioBrandMaterialSourceDigest({ ...asset, generationVersionId: undefined })).toBe(old);
  });
  it("rejects foreign and ambiguous storage keys, preserving workspace-prefixed generations", () => {
    for (const key of ["", "foreign/a.png", "w/../a.png", "w/a%2f.png", "w\\a.png", "w//a.png", "w/a.png?token=bad", "generations/other/a.png"])
      expect(studioBrandObjectKey(key, "w")).toBe(false);
    expect(studioBrandObjectKey("w/a.png", "w")).toBe(true);
    expect(studioBrandObjectKey("generations/w/a.png", "w")).toBe(true);
  });
});
