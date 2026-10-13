import type { BrandRule, WorkspaceRole } from "@brandai/contracts";

export function canEditKnowledge(role: WorkspaceRole | undefined): boolean {
  return role === "OWNER" || role === "EDITOR";
}

/** The new entry always pins a workspace; a malformed explicit URL must not fall back to cookies. */
export function knowledgePageLocation(params: Record<string, string | string[] | undefined>) {
  const wsId = params.workspaceId;
  if (typeof wsId !== "string" || !wsId.trim() || wsId.length > 128) {
    throw new Error("请从工作台选择品牌后打开知识库。");
  }
  const embedded = params.embedded === "1";
  const query = new URLSearchParams({ workspaceId: wsId });
  if (embedded) query.set("embedded", "1");
  return { wsId, embedded, callback: "/studio-brand-knowledge?" + query,
    returnUrl: "/studio?" + new URLSearchParams({ workspaceId: wsId }) + "#/brand" };
}

export function ruleReplacementMessage(rule: Pick<BrandRule, "id" | "type" | "status">, rules: BrandRule[]) {
  if (rule.status === "CONFIRMED") return null;
  const previous = rules.filter(item => item.type === rule.type && item.id !== rule.id && item.status === "CONFIRMED");
  return previous.length
    ? `启用后会替换同类别已启用的 ${previous.length} 条规则，原规则仍保留为已停用。继续启用？`
    : null;
}

export function knowledgeValue(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("补充信息必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

export type DraftImportAttempt = { mutationId: string; expectedDraftRevision: number };
export function restoredImportAttempt(raw: string | null): DraftImportAttempt | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.mutationId)
      && Number.isSafeInteger(value.expectedDraftRevision) && value.expectedDraftRevision >= 1 && value.expectedDraftRevision <= 2147483646) {
      return { mutationId: value.mutationId, expectedDraftRevision: value.expectedDraftRevision };
    }
  } catch { /* A corrupt local pointer never becomes a request. */ }
  return null;
}

/** An uncertain receipt must retry the original request even if the draft changed meanwhile. */
export function draftImportAttempt(pending: DraftImportAttempt | null, revision: number, newId: () => string): DraftImportAttempt {
  return pending ?? { mutationId: newId(), expectedDraftRevision: revision };
}
