"use client";

import React, { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@brandai/ui";
import type { StudioBrandDraftImportState, StudioBrandDraftImportResult } from "../../../../../packages/contracts/src/studio-brand-knowledge";
import { apiFetch, ApiFetchError } from "../../lib/client";
import { draftImportAttempt, restoredImportAttempt, type DraftImportAttempt } from "./knowledge-state";

export function DraftImportPanel({ wsId, userId, canEdit, onImported }: {
  wsId: string; userId: string; canEdit: boolean; onImported: () => void;
}) {
  const url = "/api/studio/brand-knowledge/import-draft?" + new URLSearchParams({ workspaceId: wsId });
  const storageKey = `novart:knowledge-import:${userId}:${wsId}`;
  const [pending, setPending] = useState<DraftImportAttempt | null>(null);
  const [restored, setRestored] = useState(false);
  const [receipt, setReceipt] = useState<StudioBrandDraftImportResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const draft = useQuery({ queryKey: ["knowledge-draft-import", wsId, userId],
    queryFn: () => apiFetch<StudioBrandDraftImportState>(url, { headers: { "X-Novart-User": userId } }) });
  useEffect(() => {
    setRestored(false); setReceipt(null); setLocalError(null);
    try { setPending(restoredImportAttempt(sessionStorage.getItem(storageKey))); }
    catch { setPending(null); }
    setRestored(true);
  }, [storageKey]);
  const submit = useMutation({
    mutationFn: async () => {
      if (!canEdit || !draft.data || !restored) throw new Error("当前无法导入，请先读取品牌草稿。");
      const attempt = draftImportAttempt(pending, draft.data.draftRevision, () => crypto.randomUUID());
      // Persist before POST; if this fails, do not send an unrecoverable mutation.
      try { sessionStorage.setItem(storageKey, JSON.stringify(attempt)); }
      catch { throw new Error("浏览器无法保存导入回执线索，未提交。请允许此页面使用会话存储后重试。"); }
      setPending(attempt); setLocalError(null);
      return apiFetch<StudioBrandDraftImportResult>(url, { method: "POST", headers: { "X-Novart-User": userId }, body: JSON.stringify(attempt) });
    },
    retry: false,
    onSuccess: result => {
      setReceipt(result); setPending(null);
      try { sessionStorage.removeItem(storageKey); } catch { /* Replaying a retained receipt is safe. */ }
      onImported(); void draft.refetch();
    },
  });
  const conflict = submit.error instanceof ApiFetchError && submit.error.status === 409;
  const importedCurrentRevision = receipt && receipt.draftRevision === draft.data?.draftRevision;
  const clearStaleAttempt = async () => {
    const fresh = await draft.refetch();
    if (!fresh.isSuccess) return;
    try { sessionStorage.removeItem(storageKey); }
    catch { setLocalError("无法清除旧请求线索，请检查浏览器会话存储后重试。"); return; }
    setPending(null); submit.reset(); setLocalError(null);
  };
  return <section className="rounded-2xl border border-border bg-card p-4" aria-label="从品牌草稿导入">
    <div className="flex flex-wrap items-center justify-between gap-3"><div>
      <h2 className="text-sm font-medium">从已保存的品牌草稿导入</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">只导入颜色和字体为待确认规则，不覆盖已启用规则。自由备注保留在来源记录中，不会自动发布成知识规则，请人工分类补充。</p>
    </div><Button variant="outline" disabled={!canEdit || !restored || !draft.data || (!pending && (!draft.data.available || !!importedCurrentRevision)) || submit.isPending || conflict}
      onClick={() => submit.mutate()}>{submit.isPending ? "正在导入…" : pending ? "重试原导入请求" : importedCurrentRevision ? "此草稿版本已导入" : "导入为待确认规则"}</Button></div>
    {draft.isLoading && <p role="status" className="mt-2 text-xs">正在读取已保存草稿…</p>}
    {draft.data && !draft.data.available && !pending && <p className="mt-2 text-xs text-muted-foreground">还没有可导入的已保存草稿；请先在“品牌草稿”中保存。</p>}
    {receipt && <p role="status" className="mt-2 text-sm text-primary">{receipt.replayed ? "已找回原导入回执" : "导入完成"}：{receipt.created} 条规则草稿。{receipt.replayed ? "这是原请求的结果，未重复创建或恢复已删除规则。" : "请核对后逐项启用。"}</p>}
    {(draft.error || submit.error || localError) && <p role="alert" className="mt-2 text-sm text-destructive">{localError ?? (submit.error ?? draft.error)?.message}</p>}
    {pending && !conflict && !submit.isPending && <p className="mt-2 text-xs text-muted-foreground">若上次回执未收到，请重试原请求；重试使用相同编号，不会重复导入。</p>}
    {conflict && <Button variant="outline" className="mt-3" onClick={() => { void clearStaleAttempt(); }}>重新读取草稿后准备新导入</Button>}
  </section>;
}
