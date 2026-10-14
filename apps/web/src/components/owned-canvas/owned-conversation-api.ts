import { z } from "zod";
import { StudioConversationInput, StudioConversationMessage, StudioConversationPage, StudioConversationDraft, StudioConversationDraftInput } from "@brandai/contracts";
import { NovartApiError } from "../../lib/novart-api-client";

export function createOwnedConversationApi(workspaceId: string, projectId: string, userId: string, signal?: AbortSignal) {
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/studio-conversation`;
  async function request<T>(query: Record<string, string>, schema: z.ZodType<T, z.ZodTypeDef, unknown>, method = "GET", body?: unknown): Promise<T> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(endpoint + (Object.keys(query).length ? "?" + new URLSearchParams(query) : ""), { method, credentials: "same-origin", cache: "no-store",
        headers: { "X-Novart-User": userId, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      const value = await response.json();
      if (!response.ok) throw new NovartApiError(typeof value?.error === "string" ? value.error : "对话尚未确认，请重新读取。", response.status, value?.code, method !== "GET" && response.status >= 500);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new NovartApiError("对话回执不完整，原需求和引用仍保留。", response.status, "INVALID_RECEIPT", method !== "GET");
      return parsed.data;
    } catch (error) {
      if (error instanceof NovartApiError) throw error;
      throw new NovartApiError("连接中断或等待超时，请读取原任务确认，勿重复发送新请求。", null, undefined, method !== "GET");
    } finally { clearTimeout(timer); }
  }
  return {
    list: (before?: string) => request({ limit: "20", ...(before ? { before } : {}) }, StudioConversationPage),
    read: (messageId: string) => request({ messageId }, StudioConversationMessage),
    send: (input: z.infer<typeof StudioConversationInput>) => request({}, StudioConversationMessage, "POST", StudioConversationInput.parse(input)),
    saveDraft: (input: z.infer<typeof StudioConversationDraftInput>) => request({}, StudioConversationDraft, "PUT", StudioConversationDraftInput.parse(input)),
  };
}
