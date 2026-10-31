"use client";

import { useEffect, useRef, useState } from "react";
import type { BrandWorkspace, BrandDeletionInput, BrandDeletionPreview } from "@brandai/contracts";
import { BrandDeletionError, clearBrandDeletionRecovery, readBrandDeletion, readBrandDeletionRecovery, saveBrandDeletionRecovery } from "@/lib/brand-deletion-client";

export function DeleteBrandDialog({ brand, userId, onClose, onDelete }: {
  brand: BrandWorkspace; userId: string; onClose: () => void; onDelete: (input: BrandDeletionInput) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const [pending, setPending] = useState(() => readBrandDeletionRecovery(userId, brand.id));
  const [confirmation, setConfirmation] = useState(pending?.confirmationName ?? "");
  const [summary, setSummary] = useState<BrandDeletionPreview | null>(null);
  const [loading, setLoading] = useState(!pending);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(pending ? "上次删除结果尚未确认，请检查原请求的结果。" : null);

  async function load() {
    if (operation.current || pending) return;
    operation.current = true; setLoading(true); setSummary(null); setError(null);
    try { const value = await readBrandDeletion(brand.id); if (alive.current) setSummary(value); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "影响范围读取失败，请重新检查。"); }
    finally { operation.current = false; if (alive.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    if (!pending) void load();
    return () => { alive.current = false; };
    // The parent keys this dialog by actor + workspace, so no request can cross scopes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (operation.current || loading || (!pending && (!summary?.canDelete || confirmation !== summary.name))) return;
    operation.current = true; setDeleting(true); setError(null);
    try {
      const request = pending ?? { confirmationName: confirmation, confirmationToken: summary!.confirmationToken, mutationId: crypto.randomUUID() };
      if (!pending) { saveBrandDeletionRecovery(userId, brand.id, request); setPending(request); }
      await onDelete(request);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof BrandDeletionError && !error.uncertain && error.status) {
        clearBrandDeletionRecovery(userId, brand.id); setPending(null); setSummary(null); setConfirmation("");
      }
      setError(error instanceof Error ? error.message : "删除结果尚未确认，请检查上次删除结果。");
    } finally { operation.current = false; if (alive.current) setDeleting(false); }
  }

  return <dialog ref={dialog} role="alertdialog" aria-label="删除品牌套件" onCancel={event => { event.preventDefault(); if (!deleting) onClose(); }}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); if (!deleting && event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); }}
    className="m-auto max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-md overflow-auto rounded-2xl border border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-foreground/35 backdrop:backdrop-blur-sm">
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="px-5 py-5">
        <h2 className="text-base font-semibold">删除“{summary?.name ?? brand.name}”？</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">该品牌的项目、素材、生成记录和品牌规范将无法再访问，成员将失去该品牌访问权限。删除后无法恢复。</p>
        <p role="status" className="mt-3 text-sm" data-testid="brand-delete-impact">{loading ? "正在读取影响范围…" : summary ? `${summary.counts.projects} 个项目、${summary.counts.assets} 个素材、${summary.counts.rules} 条规则、${summary.counts.terms} 条术语、${summary.counts.prohibitions} 条禁用约束、${summary.counts.inspirationCases} 个灵感案例；涉及 ${summary.counts.members} 位成员。` : pending ? "上次删除结果尚未确认。" : "尚未确认影响范围。"}</p>
        {summary && !summary.canDelete && <p role="alert" className="mt-3 text-sm text-destructive">{summary.blockedReason || "当前不能删除品牌，请稍后重新检查。"}</p>}
        <label className="mt-4 flex flex-col gap-2 text-xs">输入品牌名称“{summary?.name ?? brand.name}”确认
          <input aria-label="输入品牌名称确认删除" value={confirmation} disabled={loading || deleting || Boolean(pending)} autoComplete="off" onChange={event => setConfirmation(event.target.value)} className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary" />
        </label>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
        <button type="button" disabled={deleting} onClick={onClose} className="h-10 rounded-xl border border-border px-4 text-sm text-muted-foreground hover:bg-muted disabled:opacity-60">取消</button>
        <button type="button" disabled={loading || deleting || Boolean(pending)} onClick={() => void load()} className="h-10 rounded-xl border border-border px-4 text-sm text-muted-foreground hover:bg-muted disabled:opacity-60">重新检查</button>
        <button type="submit" disabled={deleting || loading || (!pending && (!summary?.canDelete || confirmation !== summary.name))} className="h-10 rounded-xl bg-destructive px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">{deleting ? "正在核对…" : pending ? "检查上次删除结果" : "确认删除"}</button>
      </div>
    </form>
  </dialog>;
}
