"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { requireOwnedLayerSource } from "../../lib/owned-canvas-decomposition";
import { NovartApiError } from "../../lib/novart-api-client";
import { createOwnedLayerRecovery } from "./owned-layer-recovery";
import type { createOwnedEditorApi, DecompositionInput, DecompositionTask } from "./owned-editor-api";

type Api = ReturnType<typeof createOwnedEditorApi>;
type Props = {
  api: Api | null; workspaceId: string; projectId: string; userId: string;
  document: OwnedCanvasDocument | null; selectedIds: string[]; readOnly: boolean;
  onPrepare: () => Promise<{ document: OwnedCanvasDocument; revision: number }>;
  onPlace: (task: DecompositionTask) => Promise<void>;
};
const control = "rounded-full border border-border bg-card px-3 py-2 text-xs text-fg hover:bg-muted disabled:opacity-40";
const message = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重新读取任务。";
const matches = (input: DecompositionInput, task: DecompositionTask) => input.mutationId === task.mutationId && input.projectId === task.projectId
  && input.assetId === task.assetId && input.assetSha256 === task.assetSha256 && input.sourceShapeId === task.sourceShapeId
  && input.documentRevision === task.documentRevision && input.layerCount === task.layerCount;

export function OwnedLayerPanel({ api, workspaceId, projectId, userId, document, selectedIds, readOnly, onPrepare, onPlace }: Props) {
  const [tasks, setTasks] = useState<DecompositionTask[]>([]), [layerCount, setLayerCount] = useState(4), [intent, setIntent] = useState("");
  const [pending, setPending] = useState(false), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [blocked, setBlocked] = useState(false), [notice, setNotice] = useState("");
  const recovery = useRef<ReturnType<typeof createOwnedLayerRecovery> | null>(null), operation = useRef<DecompositionInput | null>(null);
  const alive = useRef(true), activeApi = useRef(api), serial = useRef(false), readBusy = useRef(false);
  activeApi.current = api;
  const source = selectedIds.length === 1 ? document?.items.find(item => item.id === selectedIds[0] && item.kind === "image") : undefined;
  let sourceError = "请选择一张已保存的图片。";
  if (source && document && source.assetId && source.assetSha256) {
    try { requireOwnedLayerSource(document, { sourceShapeId: source.id, assetId: source.assetId, assetSha256: source.assetSha256 }); sourceError = ""; }
    catch (error) { sourceError = message(error); }
  }
  const current = (expected: Api) => alive.current && activeApi.current === expected;
  const accept = (task: DecompositionTask) => setTasks(values => [task, ...values.filter(value => value.requestId !== task.requestId)].slice(0, 50));
  const confirm = useCallback((values: DecompositionTask[]) => {
    const input = operation.current;
    if (input && values.some(task => matches(input, task))) {
      if (!recovery.current) throw new Error("分层确认记录尚未准备完成。");
      recovery.current.clear(input); operation.current = null; setPending(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    const expected = activeApi.current;
    if (!expected || readBusy.current) return;
    readBusy.current = true; setReading(true);
    try {
      const values = await expected.listDecompositions();
      if (!current(expected)) return;
      setTasks(values); confirm(values);
    } catch (error) { if (current(expected)) setNotice(message(error)); }
    finally { if (current(expected)) { readBusy.current = false; setReading(false); } }
  }, [confirm]);

  useEffect(() => {
    alive.current = true; operation.current = null; setPending(false); setBlocked(false); setTasks([]);
    try {
      recovery.current = createOwnedLayerRecovery({ workspaceId, projectId, userId });
      operation.current = recovery.current.load(); setPending(!!operation.current);
      if (operation.current) setNotice("上次分层受理结果还未确认。页面只读取已有任务，确认按钮会使用同一次请求。");
    } catch (error) { setBlocked(true); setNotice(message(error)); }
    void refresh();
    return () => { alive.current = false; };
  }, [workspaceId, projectId, userId, api, refresh]);
  useEffect(() => {
    if (!tasks.some(task => ["PENDING", "RUNNING"].includes(task.status) && Date.parse(task.expiresAt) > Date.now())) return;
    const timer = setTimeout(() => void refresh(), 2500); return () => clearTimeout(timer);
  }, [tasks, refresh]);

  async function submit() {
    const expected = activeApi.current;
    if (!expected || readOnly || blocked || serial.current) return;
    serial.current = true; setBusy(true);
    try {
      if (!operation.current) {
        const saved = await onPrepare(); if (!current(expected)) return;
        const selected = selectedIds.length === 1 ? saved.document.items.find(item => item.id === selectedIds[0]) : null;
        if (!selected?.assetId || !selected.assetSha256) throw new Error("请先选择一张已存入当前项目的图片。");
        requireOwnedLayerSource(saved.document, { sourceShapeId: selected.id, assetId: selected.assetId, assetSha256: selected.assetSha256 });
        if (!recovery.current) throw new Error("分层确认记录暂不可用，本次未提交。");
        operation.current = recovery.current.store({ projectId, mutationId: crypto.randomUUID(), sourceShapeId: selected.id,
          assetId: selected.assetId, assetSha256: selected.assetSha256, documentRevision: saved.revision, layerCount, ...(intent.trim() ? { intent: intent.trim() } : {}) });
        setPending(true);
      }
      const receipt = await expected.submitDecomposition(operation.current);
      if (!current(expected)) return;
      accept(receipt); confirm([receipt]); setNotice(receipt.status === "SUCCEEDED" ? "图层已保存，可展开到画布。" : "分层已受理。关闭页面后任务仍会继续，可稍后回到此项目查看。");
    } catch (error) {
      if (!current(expected)) return;
      if (error instanceof NovartApiError && !error.uncertain && operation.current) {
        try { recovery.current?.clear(operation.current); operation.current = null; setPending(false); }
        catch (recoveryError) { setBlocked(true); setNotice(message(recoveryError)); return; }
      }
      setNotice(message(error));
    } finally { if (current(expected)) { serial.current = false; setBusy(false); } }
  }
  async function place(task: DecompositionTask) {
    const expected = activeApi.current; if (!expected || readOnly || serial.current) return;
    serial.current = true; setBusy(true);
    try { await onPlace(task); if (current(expected)) setNotice("已展开图层，原图保留在图层列表中。可解除组合后分别编辑；撤销可恢复原图。"); }
    catch (error) { if (current(expected)) setNotice(message(error)); }
    finally { if (current(expected)) { serial.current = false; setBusy(false); } }
  }
  async function retryArchive(task: DecompositionTask) {
    const expected = activeApi.current; if (!expected || readOnly || serial.current) return;
    serial.current = true; setBusy(true);
    try { const result = await expected.retryLayerArchive(task.requestId); if (current(expected)) { accept(result); setNotice("正在重新保存已有图层，不会重新调用分层模型。"); } }
    catch (error) { if (current(expected)) setNotice(message(error)); }
    finally { if (current(expected)) { serial.current = false; setBusy(false); } }
  }
  return <section className="space-y-4" aria-label="AI 分层" data-testid="owned-layer-panel">
    <div><h2 className="text-sm font-semibold">AI 分层</h2><p className="mt-1 text-xs leading-5 text-muted-fg">把图片拆成可分别编辑的透明图层，保留原图。分层会使用模型额度，提交前可调整层数。</p></div>
    <p className="text-xs leading-5 text-muted-fg">{sourceError || "已选择原图片。原图和全部结果分别保存，完成后由你展开。"}</p>
    <label className="block text-xs text-muted-fg">拆分层数<select aria-label="拆分层数" className={control + " ml-2"} value={layerCount} disabled={readOnly || busy || pending || blocked} onChange={event => setLayerCount(Number(event.target.value))}>{Array.from({ length: 9 }, (_, index) => index + 2).map(value => <option key={value} value={value}>{value} 层</option>)}</select></label>
    <textarea aria-label="分层说明" className="min-h-24 w-full rounded-2xl border border-border bg-bg p-3 text-sm" placeholder="可选：优先拆分主体、文字和背景…" maxLength={500} value={intent} disabled={readOnly || busy || pending || blocked} onChange={event => setIntent(event.target.value)} />
    <button type="button" className="w-full rounded-full bg-primary py-3 text-sm text-primary-fg disabled:opacity-40" disabled={!api || readOnly || busy || blocked || !pending && !!sourceError} onClick={() => void submit()}>{busy ? "正在确认…" : pending ? "确认同一次分层" : "开始 AI 分层"}</button>
    {!!notice && <p role="status" className="rounded-xl bg-accent-soft p-3 text-xs leading-6" data-testid="owned-layer-notice">{notice}</p>}
    <button type="button" className={control} disabled={reading || busy} onClick={() => void refresh()}>{reading ? "正在读取…" : "刷新分层任务"}</button>
    {!tasks.length && <p className="py-4 text-center text-xs text-muted-fg">当前项目还没有分层任务。</p>}
    {tasks.map(task => <article className="space-y-3 rounded-2xl border border-border p-3" key={task.requestId} data-testid="owned-layer-task" data-status={task.status}>
      <div className="flex justify-between text-xs"><strong>{task.layerCount} 层分解</strong><span>{task.status === "SUCCEEDED" ? "图层已保存" : task.status === "FAILED" ? "未完成" : Date.parse(task.expiresAt) <= Date.now() ? "等待确认超时" : task.status === "RUNNING" ? "正在分层" : "等待处理"}</span></div>
      {task.error && <p role="alert" className="text-xs leading-5 text-muted-fg">{task.error}</p>}
      {task.layers.length > 0 && <div className="grid grid-cols-2 gap-2">{task.layers.map(layer => <div key={layer.assetId} className="rounded-xl bg-muted p-2"><img src={layer.url} alt={"图层 " + (layer.order + 1)} loading="lazy" className="aspect-square w-full object-contain" /><p className="mt-1 text-xs text-muted-fg">图层 {layer.order + 1}</p></div>)}</div>}
      {task.status === "SUCCEEDED" && <button type="button" className={control + " w-full"} disabled={readOnly || busy} onClick={() => void place(task)}>展开为可编辑图层</button>}
      {task.canRetryArchive && <button type="button" className={control} disabled={readOnly || busy} onClick={() => void retryArchive(task)}>重新保存已有图层</button>}
    </article>)}
  </section>;
}
