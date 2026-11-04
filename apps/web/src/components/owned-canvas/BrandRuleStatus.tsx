"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { StudioBrandRuleStatus as StatusSchema, type StudioBrandRuleStatus as Status } from "../../../../../packages/contracts/src/studio-brand-rule-status";

export function brandRuleStatusMessage(status: Status) {
  if (!status.applicationEnabled) return "应用到项目已关闭，本次普通生图不会带上品牌规则。";
  // Rules reach the model as prompt text, not as a hard constraint. Saying
  // "已应用" made users read a color deviation as a bug in the rule library,
  // so state the actual mechanism and where deviations surface instead.
  if (status.confirmedCount > 0) return `本次生图会带上 ${status.confirmedCount} 条已启用规则；模型可能不完全遵循，偏差以生成后的颜色核对为准。`;
  if (status.draftCount > 0) return "尚无已启用规则；请在品牌知识页核对草稿并启用。";
  if (status.savedDraftAvailable) return "已保存颜色/字体资料，但尚无已启用规则；请在品牌知识页导入草稿并核对启用。";
  return "尚无品牌规则；可在品牌知识页上传识别或手动添加，核对后启用。";
}

/** Read-only status; opening knowledge in another tab preserves the image prompt. */
export function BrandRuleStatus({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const scope = JSON.stringify([workspaceId, userId]);
  const [state, setState] = useState<{ scope: string; data?: Status; error?: string; loading: boolean }>({ scope, loading: true });
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    setState({ scope, loading: true });
    try {
      const response = await fetch(`/api/studio/brand-knowledge/status?${new URLSearchParams({ workspaceId })}`, {
        headers: { "X-Novart-User": userId }, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error("品牌状态读取失败，请重新读取。");
      const data = StatusSchema.parse(await response.json());
      if (data.workspaceId !== workspaceId) throw new Error("品牌状态不匹配，请刷新工作台。");
      if (pending.current === controller) setState({ scope, data, loading: false });
    } catch {
      if (pending.current === controller) setState({ scope, error: "品牌状态暂不可用，不能确认本次会应用哪些规则。", loading: false });
    } finally { clearTimeout(timer); }
  }, [scope, workspaceId, userId]);
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { window.removeEventListener("focus", focus); const old = pending.current; pending.current = null; old?.abort(); };
  }, [refresh]);
  const current: typeof state = state.scope === scope ? state : { scope, loading: true };
  return <div className="space-y-1 rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground" data-testid="brand-rule-status">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {/* The disclosure that wraps this block already says 品牌规范; repeat only the state. */}
      {current.data && <span>{current.data.brandName} · 已启用 {current.data.confirmedCount} 条 · 草稿 {current.data.draftCount} 条 · 应用{current.data.applicationEnabled ? "开启" : "关闭"}</span>}
      <a className="text-primary underline" href={`/studio-brand-knowledge?${new URLSearchParams({ workspaceId })}`} target="_blank" rel="noopener noreferrer">品牌知识 ↗</a>
      <button type="button" className="underline disabled:opacity-40" disabled={current.loading} onClick={() => void refresh()}>刷新</button>
    </div>
    <p role={current.error ? "alert" : "status"}>{current.loading ? "读取中…" : current.error ?? (current.data && brandRuleStatusMessage(current.data))}</p>
  </div>;
}
