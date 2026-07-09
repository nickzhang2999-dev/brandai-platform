export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;
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
  if (!(file.type ?? "").startsWith("image/")) return null;
  if (file.size <= MAX_IMAGE_UPLOAD_BYTES) return null;
  const name = file.name ? `「${file.name}」` : "图片";
  return `${name}不能超过 ${formatUploadBytes(MAX_IMAGE_UPLOAD_BYTES)}，当前 ${formatUploadBytes(file.size)}。`;
}

export function validateImageUploadFile(file: UploadLike): void {
  const err = imageUploadLimitError(file);
  if (err) throw new Error(err);
}
