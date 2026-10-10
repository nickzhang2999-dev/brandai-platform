import { classifyUploadFailure, sanitizeUploadFailure, uploadTaskToken } from "../src/lib/studio-upload-diagnostics";

export type UploadIdentity = { projectId: string; mutationId: string; fileName: string; sha256: string; sizeBytes: number };
export type AcceptedUpload = UploadIdentity & { taskId: string; workspaceId: string };
const status = (value: unknown) => ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"].includes(String(value)) ? String(value) : "UNKNOWN";
export function uploadReceiptMatches(value: unknown, request: UploadIdentity & { taskId: string }): value is { taskId: string; projectId: string; mutationId: string } {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return typeof row.taskId === "string" && /^smu_[a-f0-9]{32}$/.test(row.taskId) && row.taskId === request.taskId && row.projectId === request.projectId && row.mutationId === request.mutationId;
}
export function summarizeUploadReceipt(value: unknown) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { status: status(row.status), progress: typeof row.progress === "number" && row.progress >= 0 && row.progress <= 100 ? row.progress : null,
    materialPresent: !!row.material, failure: classifyUploadFailure(row.error) };
}
export type UploadEvidenceRow = { taskId: string; workspaceId: string; projectId: string; mutationId: string; fileName: string; sha256: string;
  sizeBytes: number; bodyBytes: number | null; assetId: string | null; attemptToken: string | null; width: number | null; height: number | null;
  expiresAt: Date; status: string; progress: number; error: string | null; assetPresent: boolean; assetDeprecated: boolean };
export function summarizeUploadRow(row: UploadEvidenceRow | undefined, accepted: AcceptedUpload, now = Date.now()) {
  if (!row) return { task: uploadTaskToken(accepted.taskId), present: false };
  return { task: uploadTaskToken(accepted.taskId), present: true, status: status(row.status), progress: row.progress,
    requestMatches: row.taskId === accepted.taskId && row.workspaceId === accepted.workspaceId && row.projectId === accepted.projectId
      && row.mutationId === accepted.mutationId && row.fileName === accepted.fileName && row.sha256 === accepted.sha256 && row.sizeBytes === accepted.sizeBytes,
    sizeBytes: row.sizeBytes, stagedBytes: row.bodyBytes, stagedSizeMatches: row.bodyBytes === null ? null : row.bodyBytes === row.sizeBytes,
    claimPresent: !!row.attemptToken, assetIdPresent: !!row.assetId, assetPresent: row.assetPresent, assetDeprecated: row.assetDeprecated,
    dimensionsPresent: !!row.width && !!row.height, expired: row.expiresAt.getTime() <= now, failure: classifyUploadFailure(row.error) };
}
export function sanitizeCapturedUploadEvidence(value: unknown) {
  const object = (item: unknown): Record<string, unknown> => item && typeof item === "object" ? item as Record<string, unknown> : {};
  const raw = object(value), list = (items: unknown) => (Array.isArray(items) ? items : []).slice(-8).map(object).filter(row => typeof row.task === "string" && /^[a-f0-9]{12}$/.test(row.task));
  const number = (value: unknown, max = 256 * 1024 * 1024) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
  return { beforeFixtureCleanup: raw.beforeFixtureCleanup === true,
    records: list(raw.records).map(row => {
      const api = object(row.api);
      return { task: row.task as string, present: row.present === true, readable: row.readable !== false,
        status: status(row.status), progress: number(row.progress, 100), requestMatches: row.requestMatches === true,
        sizeBytes: number(row.sizeBytes), stagedBytes: number(row.stagedBytes), stagedSizeMatches: typeof row.stagedSizeMatches === "boolean" ? row.stagedSizeMatches : null,
        claimPresent: row.claimPresent === true, assetIdPresent: row.assetIdPresent === true, assetPresent: row.assetPresent === true, assetDeprecated: row.assetDeprecated === true,
        dimensionsPresent: row.dimensionsPresent === true, expired: row.expired === true, failure: sanitizeUploadFailure(row.failure),
        api: row.api ? { status: status(api.status), progress: number(api.progress, 100), materialPresent: api.materialPresent === true, failure: sanitizeUploadFailure(api.failure) } : null };
    }),
    jobs: list(raw.jobs).map(row => ({ task: row.task as string, present: row.present === true,
      state: ["active", "completed", "delayed", "failed", "waiting", "waiting-children", "unknown"].includes(String(row.state)) ? String(row.state) : "unknown",
      attemptsMade: number(row.attemptsMade, 1000), failure: sanitizeUploadFailure(row.failure) })),
    ...(raw.queueError ? { queueError: sanitizeUploadFailure(raw.queueError) } : {}) };
}
