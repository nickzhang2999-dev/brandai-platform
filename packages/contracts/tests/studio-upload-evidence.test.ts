import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyUploadFailure, summarizeUploadWorkerEvents, uploadFailureEvent } from "../../../apps/web/src/lib/studio-upload-diagnostics";
import { sanitizeCapturedUploadEvidence, summarizeUploadReceipt, summarizeUploadRow, uploadReceiptMatches, type AcceptedUpload, type UploadEvidenceRow } from "../../../apps/web/scripts/studio-upload-evidence";

const input = Buffer.from("synthetic image bytes"), sha256 = createHash("sha256").update(input).digest("hex");
const accepted: AcceptedUpload = { taskId: "smu_" + "a".repeat(32), projectId: "private-project", workspaceId: "private-workspace", mutationId: "12345678-1234-1234-1234-123456789012", fileName: "private-file.png", sha256, sizeBytes: input.length };
const row = (): UploadEvidenceRow => ({ ...accepted, bodyBytes: null, assetId: null, attemptToken: null, width: null, height: null, expiresAt: new Date(Date.now() + 60000), status: "FAILED", progress: 0, error: "上传内容校验失败，请重新选择图片。", assetPresent: false, assetDeprecated: false });
describe("scoped upload acceptance evidence", () => {
  it("binds a 202 to the real persisted file mutation, rejecting another task, mutation or project", () => {
    expect(uploadReceiptMatches(accepted, accepted)).toBe(true);
    expect(uploadReceiptMatches({ ...accepted, mutationId: "unrelated-upload" }, accepted)).toBe(false);
    expect(uploadReceiptMatches({ ...accepted, projectId: "another-project" }, accepted)).toBe(false);
    expect(uploadReceiptMatches({ ...accepted, taskId: "smu_" + "b".repeat(32) }, accepted)).toBe(false);
    expect(uploadReceiptMatches({ ...accepted, taskId: "not-a-task" }, accepted)).toBe(false);
  });
  it("preserves the classified terminal receipt and DB state after simulated fixture cleanup", () => {
    const source = row(), records = [source];
    const evidence = { database: summarizeUploadRow(records[0], accepted), api: summarizeUploadReceipt({ status: "FAILED", error: source.error, rawBody: "private-body" }) };
    records.splice(0); source.error = null;
    expect(evidence.database).toMatchObject({ present: true, status: "FAILED", requestMatches: true, stagedBytes: null, failure: { category: "UPLOAD_CHECKSUM_MISMATCH" } });
    expect(evidence.api.failure.category).toBe("UPLOAD_CHECKSUM_MISMATCH");
    const text = JSON.stringify(evidence); for (const value of [accepted.taskId, accepted.projectId, accepted.workspaceId, accepted.mutationId, accepted.fileName, sha256, "private-body"]) expect(text).not.toContain(value);
  });
  it("distinguishes an unavailable completed asset from a worker failure", () => {
    const evidence = summarizeUploadRow({ ...row(), status: "SUCCEEDED", error: null, assetId: "private-asset", assetPresent: false }, accepted);
    expect(evidence).toMatchObject({ status: "SUCCEEDED", assetIdPresent: true, assetPresent: false, failure: { category: "UPLOAD_NO_ERROR" } });
    expect(summarizeUploadReceipt({ status: "FAILED", error: "素材已删除或不可用，请重新上传。" }).failure.category).toBe("UPLOAD_MATERIAL_UNAVAILABLE");
  });
  it("exposes missing staging bytes and mismatched request without leaking their values", () => {
    expect(summarizeUploadRow({ ...row(), sha256: "wrong", bodyBytes: 3 }, accepted)).toMatchObject({ requestMatches: false, stagedBytes: 3, stagedSizeMatches: false });
    expect(summarizeUploadRow(undefined, accepted)).toMatchObject({ present: false });
  });
  it("classifies only allowlisted server failures and SDK codes", () => {
    expect(classifyUploadFailure(Object.assign(new Error("secret URL?token=private"), { code: "AccessDenied", status: 403, response: "private-provider-body" }))).toEqual({ category: "UPLOAD_DEPENDENCY_ERROR", errorCode: "AccessDenied", httpStatus: 403 });
    expect(classifyUploadFailure({ message: "private body", code: "private key", name: "private header", status: "401" })).toEqual({ category: "UPLOAD_UNKNOWN_ERROR", errorCode: null, httpStatus: null });
    expect(classifyUploadFailure("上传权限已变更，未添加图片。").category).toBe("UPLOAD_PERMISSION_DENIED");
  });
  it("worker events contain only hash, stage, enum and bounded values; log ingestion drops injected fields", () => {
    const event = uploadFailureEvent("private-task", "storage", true, Object.assign(new Error("secret object key"), { code: "ECONNRESET" }));
    const text = "[studio-upload-diagnostic] " + JSON.stringify({ ...event, secret: "private body", url: "https://private/?token=secret" });
    const summary = summarizeUploadWorkerEvents(text);
    expect(summary).toHaveLength(1); expect(summary[0]).toMatchObject({ stage: "storage", terminal: true, errorCode: "ECONNRESET" });
    expect(JSON.stringify(summary)).not.toMatch(/private|secret|token|https/);
    expect(summarizeUploadWorkerEvents('[studio-upload-diagnostic] {"task":"private raw id","category":"UPLOAD_STORAGE_FAILED","stage":"storage"}')).toEqual([]);
  });
  it("keeps pre-cleanup evidence in the safe CI artifact without passing through unexpected fields", () => {
    const record = summarizeUploadRow(row(), accepted);
    const summary = sanitizeCapturedUploadEvidence({ beforeFixtureCleanup: true, records: [{ ...record, secret: "private-body", api: { ...summarizeUploadReceipt({ status: "FAILED", error: row().error }), secret: "private-token" } }],
      jobs: [{ task: record.task, state: "completed", attemptsMade: 1, failedReason: "private-provider-body" }], queueError: { category: "private-value", errorCode: "private-key", httpStatus: "private-header" } });
    expect(summary.records[0]?.failure.category).toBe("UPLOAD_CHECKSUM_MISMATCH"); expect(summary.records[0]?.api?.status).toBe("FAILED"); expect(summary.jobs[0]?.state).toBe("completed");
    expect(JSON.stringify(summary)).not.toContain("private");
  });
});
