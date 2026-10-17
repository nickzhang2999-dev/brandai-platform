"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { requireOwnedLayerSource } from "../../lib/owned-canvas-decomposition";
import { NovartApiError } from "../../lib/novart-api-client";
import { createOwnedLayerRecovery } from "./owned-layer-recovery";
import type { createOwnedEditorApi, DecompositionInput, DecompositionTask } from "./owned-editor-api";
import { downloadOwnedPsd } from "./owned-psd-download";
import { OwnedLayerOptions } from "./OwnedLayerOptions";
import { matchesOwnedDecomposition, ownedLayerTaskTitle, ownedLayerTaskStatus, ownedLayerTaskNotice, type OwnedLayerMode } from "./owned-layer-options";

type Api = ReturnType<typeof createOwnedEditorApi>;
type Props = {
  api: Api | null; workspaceId: string; projectId: string; userId: string;
  document: OwnedCanvasDocument | null; selectedIds: string[]; readOnly: boolean;
  onPrepare: () => Promise<{ document: OwnedCanvasDocument; revision: number }>;
  onPlace: (task: DecompositionTask) => Promise<void>;
};
const control = "rounded-full border border-border bg-card px-3 py-2 text-xs text-foreground hover:bg-muted disabled:opacity-40";
const message = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重新读取任务。";
export function OwnedLayerPanel({ api, workspaceId, projectId, userId, document, selectedIds, readOnly, onPrepare, onPlace }: Props) {
  const [tasks, setTasks] = useState<DecompositionTask[]>([]), [layerMode, setLayerMode] = useState<OwnedLayerMode>("AUTO"), [layerCount, setLayerCount] = useState(4), [intent, setIntent] = useState("");
  const [refineSourceId, setRefineSourceId] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [blocked, setBlocked] = useState(false), [notice, setNotice] = useState("");
  const recovery = useRef<ReturnType<typeof createOwnedLayerRecovery> | null>(null), operation = useRef<DecompositionInput | null>(null);
  const alive = useRef(true), activeApi = useRef(api), serial = useRef(false), readBusy = useRef(false);
  const noticeTask = useRef<string | null>(null);
  activeApi.current = api;
  const sourceId = refineSourceId ?? (selectedIds.length === 1 ? selectedIds[0] : undefined);
  const source = document?.items.find(item => item.id === sourceId && item.kind === "image");
  const sourceLayer = source && tasks.flatMap(task => task.layers).find(layer => layer.assetId === source.assetId && layer.assetSha256 === source.assetSha256);
  const refining = !!sourceLayer;
  const selectionKey = selectedIds.join(":");
  useEffect(() => { setRefineSourceId(null); }, [selectionKey]);
  let sourceError = "请选择一张已保存的图片。";
  if (source && document && source.assetId && source.assetSha256) {
    try { requireOwnedLayerSource(document, { sourceShapeId: source.id, assetId: source.assetId, assetSha256: source.assetSha256 }); sourceError = ""; }
    catch (error) { sourceError = message(error); }
  }
  const current = (expected: Api) => alive.current && activeApi.current === expected;
  const accept = (task: DecompositionTask) => setTasks(values => [task, ...values.filter(value => value.requestId !== task.requestId)].slice(0, 50));
  const confirm = useCallback((values: DecompositionTask[]) => {
    const input = operation.current;
    if (input && values.some(task => matchesOwnedDecomposition(input, task))) {
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
    alive.current = true; operation.current = null; noticeTask.current = null; setNotice(""); setPending(false); setBlocked(false); setTasks([]); setRefineSourceId(null); setLayerMode("AUTO"); setLayerCount(4);
    try {
      recovery.current = createOwnedLayerRecovery({ workspaceId, projectId, userId });
      operation.current = recovery.current.load(); setPending(!!operation.current);
      if (operation.current) { setLayerMode(operation.current.layerMode ?? "MANUAL"); setLayerCount(operation.current.layerCount ?? 4); setNotice("上次分层的提交结果还没确认。页面只读取已有任务，点“检查上次分层”会使用同一次请求，不会重复扣费。"); }
    } catch (error) { setBlocked(true); setNotice(message(error)); }
    void refresh();
    return () => { alive.current = false; };
  }, [workspaceId, projectId, userId, api, refresh]);
  useEffect(() => {
    if (!tasks.some(task => ["PENDING", "RUNNING"].includes(task.status) && Date.parse(task.expiresAt) > Date.now())) return;
    const timer = setTimeout(() => void refresh(), 2500); return () => clearTimeout(timer);
  }, [tasks, refresh]);
  useEffect(() => {
    const task = tasks.find(value => value.requestId === noticeTask.current);
    if (!task) return;
    setNotice(ownedLayerTaskNotice(task));
    if (["FAILED", "SUCCEEDED"].includes(task.status)) noticeTask.current = null;
  }, [tasks]);

  async function submit() {
    const expected = activeApi.current;
    if (!expected || readOnly || blocked || serial.current) return;
    serial.current = true; setBusy(true);
    try {
      if (!operation.current) {
        const chosenSource = source;
        if (!chosenSource?.assetId || !chosenSource.assetSha256) throw new Error("请先选择一张已存入当前项目的图片。");
        const saved = await onPrepare(); if (!current(expected)) return;
        const selected = saved.document.items.find(item => item.id === sourceId);
        if (!selected?.assetId || !selected.assetSha256 || selected.assetId !== chosenSource.assetId || selected.assetSha256 !== chosenSource.assetSha256) throw new Error("选中的图片已变化，本次未提交；请重新选择后分层。");
        requireOwnedLayerSource(saved.document, { sourceShapeId: selected.id, assetId: selected.assetId, assetSha256: selected.assetSha256 });
        if (!recovery.current) throw new Error("分层确认记录暂不可用，本次未提交。");
        operation.current = recovery.current.store({ projectId, mutationId: crypto.randomUUID(), sourceShapeId: selected.id,
          assetId: selected.assetId, assetSha256: selected.assetSha256, documentRevision: saved.revision,
          ...(layerMode === "AUTO" ? { layerMode: "AUTO" as const } : { layerMode: "MANUAL" as const, layerCount }), ...(intent.trim() ? { intent: intent.trim() } : {}) });
        setPending(true);
      }
      const receipt = await expected.submitDecomposition(operation.current);
      if (!current(expected)) return;
      noticeTask.current = receipt.requestId;
      accept(receipt); confirm([receipt]); setNotice(ownedLayerTaskNotice(receipt));
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
    try { const result = await expected.retryLayerArchive(task.requestId); if (current(expected)) { noticeTask.current = result.requestId; accept(result); setNotice("正在重新保存已有图层，不会重新调用分层模型。"); } }
    catch (error) { if (current(expected)) setNotice(message(error)); }
    finally { if (current(expected)) { serial.current = false; setBusy(false); } }
  }
  async function download(task: DecompositionTask) {
    const expected = activeApi.current; if (!expected || serial.current || task.status !== "SUCCEEDED") return;
    serial.current = true; setBusy(true);
    try { await downloadOwnedPsd(expected, task); if (current(expected)) setNotice("PSD 已下载，原图和图层仍保留。"); }
    catch (error) { if (current(expected)) setNotice(message(error)); }
    finally { if (current(expected)) { serial.current = false; setBusy(false); } }
  }
  return <section className="space-y-4" aria-label="AI 分层" data-testid="owned-layer-panel">
    <div><h2 className="text-sm font-semibold">{refining ? "进一步分层" : "AI 分层"}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">按图片内容拆成可分别编辑的透明图层，原图保留。{layerMode === "AUTO" ? "会额外使用内容分析与分层服务额度。" : "会使用分层服务额度。"}</p></div>
    <p className="text-xs leading-5 text-muted-foreground" data-testid="owned-layer-source">{sourceError || (refining ? `已选择${sourceLayer?.name || "已保存图层"}，只拆分这一个图层，其余图层保留。` : "已选择图片。原图和全部结果分别保存，完成后由你展开。")}</p>
    {refineSourceId && source && <div className="flex items-center gap-3 rounded-2xl border border-border p-3"><img src={source.url} alt="进一步分层的对象" className="h-14 w-14 shrink-0 rounded-lg bg-muted object-contain" /><button type="button" className={control} disabled={pending || busy} onClick={() => setRefineSourceId(null)}>返回画布选中对象</button></div>}
    <OwnedLayerOptions mode={layerMode} count={layerCount} context="分层" disabled={readOnly || busy || pending || blocked} onMode={setLayerMode} onCount={setLayerCount} />
    <textarea aria-label="分层说明" className="min-h-24 w-full rounded-2xl border border-border bg-background p-3 text-sm" placeholder="可选：优先拆分主体、文字和背景…" maxLength={500} value={intent} disabled={readOnly || busy || pending || blocked} onChange={event => setIntent(event.target.value)} />
    <button type="button" className="w-full rounded-full bg-primary py-3 text-sm text-primary-foreground disabled:opacity-40" data-testid="owned-layer-submit" disabled={!api || readOnly || busy || blocked || !pending && !!sourceError} onClick={() => void submit()}>{busy ? "正在确认…" : pending ? "检查上次分层" : refining ? "进一步分层" : "开始 AI 分层"}</button>
    {!!notice && <p role="status" className="rounded-xl bg-accent-soft p-3 text-xs leading-6" data-testid="owned-layer-notice">{notice}</p>}
    <button type="button" className={control} disabled={reading || busy} onClick={() => void refresh()}>{reading ? "正在读取…" : "刷新分层任务"}</button>
    {!tasks.length && <p className="py-4 text-center text-xs text-muted-foreground">当前项目还没有分层任务。</p>}
    {tasks.map(task => <article className="space-y-3 rounded-2xl border border-border p-3" key={task.requestId} data-testid="owned-layer-task" data-status={task.status}>
      <div className="flex flex-wrap justify-between gap-2 text-xs"><strong>{ownedLayerTaskTitle(task)}</strong><span>{ownedLayerTaskStatus(task)}</span></div>
      {task.analysisSummary && <p className="text-xs leading-5 text-muted-foreground">{task.analysisSummary}</p>}
      {task.error && <p role="alert" className="text-xs leading-5 text-muted-foreground">{task.error}</p>}
      {task.layers.length > 0 && <><div className="grid grid-cols-2 gap-2">{task.layers.map(layer => {
        const label = layer.name || `图层 ${layer.order + 1}`;
        // No pixel reaches the visible-ink threshold: the model returned an
        // almost empty layer. Keep it (never drop real pixels) but say so.
        const faint = layer.inkCoverage === 0;
        const item = document?.items.find(value => value.kind === "image" && value.assetId === layer.assetId && value.assetSha256 === layer.assetSha256 && !value.hidden);
        return <div key={layer.assetId} className={"min-w-0 space-y-2 rounded-xl bg-muted p-2" + (faint ? " opacity-60" : "")} data-faint={faint || undefined}><img src={layer.url} alt={faint ? `${label}（几乎透明）` : label} loading="lazy" className="aspect-square w-full object-contain" /><p className="truncate text-xs text-muted-foreground" title={label}>{label}{faint && <span className="ml-1 rounded-full bg-background px-1.5">几乎透明</span>}</p>
          <button type="button" className={control + " w-full !px-2"} aria-label={`进一步分层：${label}`} disabled={!item || readOnly || busy || pending || blocked} onClick={() => { if (item) { setRefineSourceId(item.id); setLayerMode("AUTO"); setNotice(`已选择${label}。确认拆分后才会调用模型，原图层与其他图层仍保留。`); } }}>进一步分层</button></div>;
      })}</div>{task.layers.some(layer => layer.inkCoverage === 0) && <p className="text-xs leading-5 text-muted-foreground" data-testid="owned-layer-faint-note">标记为“几乎透明”的图层基本没有可见内容，可以在画布上隐藏或删除，不影响其他图层。</p>}<p className="text-xs leading-5 text-muted-foreground">展开到画布后，可选择其中一个图层继续细拆。</p></>}
      {task.status === "SUCCEEDED" && <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={readOnly || busy} onClick={() => void place(task)}>展开为可编辑图层</button>
        {api && <button type="button" className={control} disabled={busy} onClick={() => void download(task)} data-testid="owned-layer-psd-download">下载 PSD</button>}
      </div>}
      {task.canRetryArchive && <button type="button" className={control} disabled={readOnly || busy} onClick={() => void retryArchive(task)}>重新保存已有图层</button>}
      {task.status === "FAILED" && !task.canRetryArchive && (() => {
        // Retry only preselects the same image and settings; the paid call
        // still needs the explicit submit button below the options.
        const original = document?.items.find(item => item.id === task.sourceShapeId && item.kind === "image" && item.assetId === task.assetId && item.assetSha256 === task.assetSha256);
        return <button type="button" className={control} data-testid="owned-layer-retry" disabled={!original || readOnly || busy || pending || blocked}
          title={original ? undefined : "原图片已不在画布上，请重新选择图片后分层。"}
          onClick={() => { if (!original) return; setRefineSourceId(original.id); setLayerMode(task.layerMode); if (task.layerMode === "MANUAL") setLayerCount(task.layerCount);
            setNotice("已选好原图和原设置。点“开始 AI 分层”才会重新提交，会再次使用分层额度。"); }}>用同样设置重新分层</button>;
      })()}
    </article>)}
  </section>;
}
