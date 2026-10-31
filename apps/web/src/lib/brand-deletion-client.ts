"use client";

import { BrandDeletionInput, BrandDeletionPreview, BrandDeletionResult } from "@brandai/contracts";

export class BrandDeletionError extends Error {
  constructor(message: string, readonly uncertain = false, readonly status = 0) {
    super(message);
  }
}

const definiteFailures = new Set([400, 401, 403, 404, 409, 422]);
async function request(workspaceId: string, input?: BrandDeletionInput): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response: Response | undefined;
  try {
    response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}${input ? "" : "/deletion"}`, {
      method: input ? "DELETE" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      ...(input ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "暂时无法核对品牌删除结果。";
      throw new BrandDeletionError(message, false, response.status);
    }
    return result;
  } catch (error) {
    if (input && (!response || response.ok || !definiteFailures.has(response.status))) {
      throw new BrandDeletionError("删除结果尚未确认，请检查上次删除结果；不会发起新的删除。", true);
    }
    if (error instanceof BrandDeletionError) throw error;
    throw new BrandDeletionError(input ? "删除结果尚未确认，请检查上次删除结果。" : "影响范围读取失败，请重新检查。", Boolean(input));
  } finally { clearTimeout(timeout); }
}

export async function readBrandDeletion(workspaceId: string): Promise<BrandDeletionPreview> {
  const value = BrandDeletionPreview.safeParse(await request(workspaceId));
  if (!value.success || value.data.workspaceId !== workspaceId) throw new BrandDeletionError("品牌影响范围尚未读取完整，请重新检查。");
  return value.data;
}

export async function submitBrandDeletion(workspaceId: string, input: BrandDeletionInput): Promise<BrandDeletionResult> {
  const value = BrandDeletionResult.safeParse(await request(workspaceId, BrandDeletionInput.parse(input)));
  if (!value.success) throw new BrandDeletionError("删除回执尚未确认，请检查上次删除结果。", true);
  const { nextWorkspaceId, redirectTo, deletedWorkspaceId } = value.data;
  const expected = nextWorkspaceId === null ? "/studio" : `/studio?workspaceId=${encodeURIComponent(nextWorkspaceId)}#/home`;
  if (deletedWorkspaceId !== workspaceId || nextWorkspaceId === workspaceId || redirectTo !== expected) throw new BrandDeletionError("删除回执尚未确认，请检查上次删除结果。", true);
  return value.data;
}

const recoveryKey = (userId: string, workspaceId: string) => `brand-deletion:${userId}:${workspaceId}`;
export function readBrandDeletionRecovery(userId: string, workspaceId: string): BrandDeletionInput | null {
  try {
    const result = BrandDeletionInput.safeParse(JSON.parse(sessionStorage.getItem(recoveryKey(userId, workspaceId)) || "null"));
    return result.success ? result.data : null;
  } catch { return null; }
}
export function saveBrandDeletionRecovery(userId: string, workspaceId: string, input: BrandDeletionInput): void {
  try { sessionStorage.setItem(recoveryKey(userId, workspaceId), JSON.stringify(BrandDeletionInput.parse(input))); }
  catch { throw new BrandDeletionError("当前浏览器无法保存删除进度，请先恢复会话存储后重试。"); }
}
export function clearBrandDeletionRecovery(userId: string, workspaceId: string): void {
  try { sessionStorage.removeItem(recoveryKey(userId, workspaceId)); } catch { /* The confirmed server receipt is authoritative. */ }
}
