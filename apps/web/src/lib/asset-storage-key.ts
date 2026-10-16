import { ApiException } from "./api";

/**
 * Accept only an unambiguous object key in the authenticated route workspace.
 * This is an input boundary, not a rule for reading historical server-owned
 * keys (brand-kit/previews/website ingestion use their own namespaces).
 */
export function assertAssetStorageKey(workspaceId: string, key: string): void {
  if (
    !key.startsWith(`${workspaceId}/`) ||
    key.startsWith("/") ||
    key.includes("..") ||
    // URL delimiters, encoded traversal and controls must not change which
    // object the public URL resolves to relative to the stored raw key.
    /[\\%?#\u0000-\u0020\u007f]/.test(key) ||
    key.split("/").some(part => !part || part === ".")
  ) {
    throw new ApiException(422, "素材存储路径无效，请重新上传到当前品牌。", {
      fieldErrors: { storageKey: ["必须使用当前工作区内的有效存储路径"] },
    });
  }
}
