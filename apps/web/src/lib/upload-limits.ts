export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_ASSET_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_ASSET_UPLOAD_BODY_BYTES = MAX_ASSET_UPLOAD_BYTES + 64 * 1024;
export const MAX_BATCH_IMAGE_UPLOAD_FILES = 20;

type UploadLike = {
  name?: string;
  size: number;
  type?: string;
};

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function imageUploadLimitError(file: UploadLike): string | null {
  // PSD is a document even though its registered MIME starts with image/.
  // This client-side hint is advisory; the server derives MIME from bytes.
  const type = (file.type ?? "").toLowerCase();
  const isImage = type.startsWith("image/") && type !== "image/vnd.adobe.photoshop" && type !== "image/x-photoshop";
  const limit = isImage ? MAX_IMAGE_UPLOAD_BYTES : MAX_ASSET_UPLOAD_BYTES;
  if (file.size <= limit) return null;
  const name = file.name ? `「${file.name}」` : (isImage ? "图片" : "文件");
  return `${name}不能超过 ${formatUploadBytes(limit)}，当前 ${formatUploadBytes(file.size)}。`;
}

export function validateImageUploadFile(file: UploadLike): void {
  const err = imageUploadLimitError(file);
  if (err) throw new Error(err);
}
