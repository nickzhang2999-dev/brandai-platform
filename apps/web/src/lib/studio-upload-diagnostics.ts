import { createHash } from "node:crypto";

// Diagnostic enums only. Never forward exception text, identifiers, provider
// responses, URLs or file contents to a log/acceptance artifact.
const messages: Record<string, string> = {
  "图片上传超时，请重新选择图片上传。": "UPLOAD_EXPIRED",
  "上传内容校验失败，请重新选择图片。": "UPLOAD_CHECKSUM_MISMATCH",
  "图片损坏或格式不受支持。请上传 4000 万像素以内的静态 PNG、JPEG 或 WebP。": "UPLOAD_IMAGE_INVALID",
  "项目已归档或删除，未添加图片。": "UPLOAD_PROJECT_UNAVAILABLE",
  "项目不存在。": "UPLOAD_PROJECT_UNAVAILABLE",
  "项目已归档，无法上传图片。": "UPLOAD_PROJECT_UNAVAILABLE",
  "Workspace not found": "UPLOAD_WORKSPACE_UNAVAILABLE",
  "权限不足": "UPLOAD_PERMISSION_DENIED",
  "上传权限已变更，未添加图片。": "UPLOAD_PERMISSION_DENIED",
  "上传已结束或超时，请重新选择图片。": "UPLOAD_CLAIM_OR_DEADLINE",
  "素材已删除或不可用，请重新上传。": "UPLOAD_MATERIAL_UNAVAILABLE",
  "图片存储失败，请重新选择图片上传；若持续失败请联系管理员。": "UPLOAD_STORAGE_FAILED",
  "object storage not configured": "UPLOAD_STORAGE_UNCONFIGURED",
  "Invalid server upload object key": "UPLOAD_OBJECT_KEY_INVALID",
};
const codes = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "TimeoutError", "AbortError", "P2002", "P2003", "P2024", "P2028", "P2034"]);
const categories = new Set([...Object.values(messages), "UPLOAD_DEPENDENCY_ERROR", "UPLOAD_UNKNOWN_ERROR", "UPLOAD_NO_ERROR"]);
export const uploadStages = ["claim", "authorization", "checksum", "image-validation", "storage", "commit"] as const;
export type UploadStage = typeof uploadStages[number];
export function uploadTaskToken(taskId: string) { return createHash("sha256").update(taskId).digest("hex").slice(0, 12); }
export function classifyUploadFailure(value: unknown) {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = typeof value === "string" ? value : typeof object.message === "string" ? object.message : "";
  const code = [object.code, object.name].find(item => typeof item === "string" && codes.has(item)) as string | undefined;
  return { category: messages[message] ?? (code ? "UPLOAD_DEPENDENCY_ERROR" : message ? "UPLOAD_UNKNOWN_ERROR" : "UPLOAD_NO_ERROR"),
    errorCode: code ?? null, httpStatus: Number.isInteger(object.status) && Number(object.status) >= 400 && Number(object.status) <= 599 ? Number(object.status) : null };
}
export function uploadFailureEvent(taskId: string, stage: UploadStage, terminal: boolean, error: unknown, missingBytes = false) {
  return { task: uploadTaskToken(taskId), stage, terminal, ...classifyUploadFailure(error), ...(missingBytes ? { missingBytes: true } : {}) };
}
export function sanitizeUploadFailure(value: unknown) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { category: typeof row.category === "string" && categories.has(row.category) ? row.category : "UPLOAD_UNKNOWN_ERROR",
    errorCode: typeof row.errorCode === "string" && codes.has(row.errorCode) ? row.errorCode : null,
    httpStatus: Number.isInteger(row.httpStatus) && Number(row.httpStatus) >= 400 && Number(row.httpStatus) <= 599 ? Number(row.httpStatus) : null };
}
export function summarizeUploadWorkerEvents(text: string) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = "[studio-upload-diagnostic] ", start = line.indexOf(marker); if (start < 0) continue;
    try {
      const row = JSON.parse(line.slice(start + marker.length));
      if (!/^[a-f0-9]{12}$/.test(row.task) || !uploadStages.includes(row.stage) || !categories.has(row.category)) continue;
      result.push({ task: row.task as string, stage: row.stage as UploadStage, terminal: row.terminal === true, category: row.category as string,
        errorCode: codes.has(row.errorCode) ? row.errorCode as string : null,
        httpStatus: Number.isInteger(row.httpStatus) && row.httpStatus >= 400 && row.httpStatus <= 599 ? row.httpStatus as number : null,
        missingBytes: row.missingBytes === true });
    } catch { /* Invalid or partial log lines are never forwarded. */ }
  }
  return result.slice(-20);
}
