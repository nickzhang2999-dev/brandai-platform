"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { requireOwnedLayerSource } from "../../lib/owned-canvas-decomposition";
import { NovartApiError } from "../../lib/novart-api-client";
import { createOwnedLayerRecovery } from "./owned-layer-recovery";
import type { createOwnedEditorApi, DecompositionInput, DecompositionTask } from "./owned-editor-api";
import { downloadOwnedPsd } from "./owned-psd-download";
import { OwnedLayerWorkflow } from "./OwnedLayerWorkflow";
import { OwnedLayerOptions } from "./OwnedLayerOptions";
import { OwnedLayerComparison, OwnedLayerQualitySummary } from "./OwnedLayerComparison";
import { requireOwnedLayerRepairSource } from "./owned-layer-repair";
import { partitionOwnedLayerTasks, matchesOwnedDecomposition, ownedLayerTaskTitle, ownedLayerTaskStatus, ownedLayerTaskNotice, type OwnedLayerMode } from "./owned-layer-options";

type Api = ReturnType<typeof createOwnedEditorApi>;
type Props = {
  api: Api | null; workspaceId: string; projectId: string; userId: string;
  document: OwnedCanvasDocument | null; selectedIds: string[]; readOnly: boolean;
  onPrepare: () => Promise<{ document: OwnedCanvasDocument; revision: number }>;
  onPlace: (task: DecompositionTask) => Promise<void>;
  onTasks?: (tasks: DecompositionTask[]) => void;
  backgroundRepair?: { available: boolean; reason: string | null; pending: boolean; onRepair: (task: DecompositionTask) => Promise<void> };
};
const control = "rounded-full border border-border bg-card px-3 py-2 text-xs text-foreground hover:bg-muted disabled:opacity-40";
const message = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重新读取任务。";
export function OwnedLayerPanel({ api, workspaceId, projectId, userId, document, selectedIds, readOnly, onPrepare, onPlace, onTasks, backgroundRepair }: Props) {
  const [tasks, setTasks] = useState<DecompositionTask[]>([]), [layerMode, setLayerMode] = useState<OwnedLayerMode>("AUTO"), [layerCount, setLayerCount] = useState(4), [intent, setIntent] = useState("");
  const [refineSourceId, setRefineSourceId] = useState<string | null>(null);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [blocked, setBlocked] = useState(false), [notice, setNotice] = useState("");
  const recovery = useRef<ReturnType<typeof createOwnedLayerRecovery> | null>(null), operation = useRef<DecompositionInput | null>(null);
  const alive = useRef(true), serial = useRef(false), readBusy = useRef(false);
  const activeScope = useRef({ api, workspaceId, projectId, userId });
  const noticeTask = useRef<string | null>(null);
  // A -> B -> A may reuse an API object. Each visit still needs its own
  // identity so the first A's late finally cannot unlock the second A's work.
  if (activeScope.current.api !== api || activeScope.current.workspaceId !== workspaceId || activeScope.current.projectId !== projectId || activeScope.current.userId !== userId)
    activeScope.current = { api, workspaceId, projectId, userId };
  const sourceId = refineSourceId ?? (selectedIds.length === 1 ? selectedIds[0] : undefined);
  const source = document?.items.find(item => item.id === sourceId && item.kind === "image");
  const sourceLayer = source && tasks.flatMap(task => task.layers).find(layer => layer.assetId === source.assetId && layer.assetSha256 === source.assetSha256);
  const refining = !!sourceLayer;
  const selectionKey = selectedIds.join(":");
  useEffect(() => { onTasks?.(tasks); }, [tasks, onTasks]);
  useEffect(() => { setRefineSourceId(null); }, [selectionKey]);
  let sourceError = "请选择一张已保存的图片。";
  if (source && document && source.assetId && source.assetSha256) {
    try { requireOwnedLayerSource(document, { sourceShapeId: source.id, assetId: source.assetId, assetSha256: source.assetSha256 }); sourceError = ""; }
    catch (error) { sourceError = message(error); }
  }
  const current = (context: typeof activeScope.current) => alive.current && activeScope.current === context;
  const accept = (task: DecompositionTask) => setTasks(values => [task, ...values.filter(value => value.requestId !== task.requestId)].slice(0, 50));
  const confirm = useCallback((values: DecompositionTask[]) => {
    const input = operation.current;
    if (input && values.some(task => matchesOwnedDecomposition(input, task))) {
      if (!recovery.current) throw new Error("分层确认记录尚未准备完成。");
      recovery.current.clear(input); operation.current = null; setPending(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    const context = activeScope.current, expected = context.api;
    if (!expected || readBusy.current) return;
    readBusy.current = true; setReading(true);
    try {
      const values = await expected.listDecompositions();
      if (!current(context)) return;
      setTasks(values); confirm(values);
    } catch (error) { if (current(context)) setNotice(message(error)); }
    finally { if (current(context)) { readBusy.current = false; setReading(false); } }
  }, [confirm]);
  useEffect(() => { const check = () => { if (window.document.visibilityState !== "hidden") void refresh(); }; window.addEventListener("focus", check); return () => window.removeEventListener("focus", check); }, [refresh]);


  useEffect(() => {
    alive.current = true; serial.current = false; readBusy.current = false; setBusy(false); setReading(false);
    operation.current = null; noticeTask.current = null; setNotice(""); setPending(false); setBlocked(false); setTasks([]); setRefineSourceId(null); setComparisonId(null); setLayerMode("AUTO"); setLayerCount(4);
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
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      // Failed reads leave tasks unchanged, so React will not re-arm this
      // effect. Continue safe reads until the existing task's own deadline.
      if (!stopped && tasks.some(task => ["PENDING", "RUNNING"].includes(task.status) && Date.parse(task.expiresAt) > Date.now()))
        timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [tasks, refresh]);
  useEffect(() => {
    const task = tasks.find(value => value.requestId === noticeTask.current);
    if (!task) return;
    setNotice(ownedLayerTaskNotice(task));
    if (["FAILED", "SUCCEEDED"].includes(task.status)) noticeTask.current = null;
  }, [tasks]);

  async function submit() {
    const context = activeScope.current, expected = context.api;
    if (!expected || readOnly || blocked || serial.current) return;
    serial.current = true; setBusy(true);
    try {
      if (!operation.current) {
        const chosenSource = source;
        if (!chosenSource?.assetId || !chosenSource.assetSha256) throw new Error("请先选择一张已存入当前项目的图片。");
        const saved = await onPrepare(); if (!current(context)) return;
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
      if (!current(context)) return;
      noticeTask.current = receipt.requestId;
      accept(receipt); confirm([receipt]); setNotice(ownedLayerTaskNotice(receipt));
    } catch (error) {
      if (!current(context)) return;
      if (error instanceof NovartApiError && !error.uncertain && operation.current) {
        try { recovery.current?.clear(operation.current); operation.current = null; setPending(false); }
        catch (recoveryError) { setBlocked(true); setNotice(message(recoveryError)); return; }
      }
      setNotice(message(error));
    } finally { if (current(context)) { serial.current = false; setBusy(false); } }
  }
  async function place(task: DecompositionTask) {
    const context = activeScope.current, expected = context.api; if (!expected || readOnly || serial.current) return;
    serial.current = true; setBusy(true);
    try { await onPlace(task); if (current(context)) setNotice("已展开图层，原图仍保留。可分别移动、缩放图片图层；其中的文字仍是图片，请核对后使用。"); }
    catch (error) { if (current(context)) setNotice(message(error)); }
    finally { if (current(context)) { serial.current = false; setBusy(false); } }
  }
  async function retryArchive(task: DecompositionTask) {
    const context = activeScope.current, expected = context.api; if (!expected || readOnly || serial.current) return;
    serial.current = true; setBusy(true);
    try { const result = await expected.retryLayerArchive(task.requestId); if (current(context)) { noticeTask.current = result.requestId; accept(result); setNotice("正在检查并保存原任务的结果，不会重新提交分层模型。"); } }
    catch (error) { if (current(context)) setNotice(message(error)); }
    finally { if (current(context)) { serial.current = false; setBusy(false); } }
  }
  async function download(task: DecompositionTask) {
    const context = activeScope.current, expected = context.api; if (!expected || serial.current || task.status !== "SUCCEEDED") return;
    serial.current = true; setBusy(true);
    try { await downloadOwnedPsd(expected, task); if (current(context)) setNotice("PSD 已下载，包含图片图层，文字仍非原生文字层。原图和图层仍保留。"); }
    catch (error) { if (current(context)) setNotice(message(error)); }
    finally { if (current(context)) { serial.current = false; setBusy(false); } }
  }
  async function repair(task: DecompositionTask) {
    const context = activeScope.current;
    if (!backgroundRepair?.available || backgroundRepair.pending || readOnly || serial.current || pending || blocked) return;
    serial.current = true; setBusy(true);
    try { await backgroundRepair.onRepair(task); }
    catch (error) { if (current(context)) setNotice(message(error)); }
    finally { if (current(context)) { serial.current = false; setBusy(false); } }
  }
  const renderTask = (task: DecompositionTask) => <article className="space-y-3 rounded-2xl border border-border p-3" key={task.requestId} data-testid="owned-layer-task" data-request-id={task.requestId} data-status={task.status}>
      <div className="flex flex-wrap justify-between gap-2 text-xs"><strong>{ownedLayerTaskTitle(task)}</strong><span>{ownedLayerTaskStatus(task)}</span></div>
      <time className="block text-xs text-muted-foreground" dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
      <OwnedLayerWorkflow task={task} />
      {task.analysisSummary && <p className="text-xs leading-5 text-muted-foreground">{task.analysisSummary}</p>}
      {task.error && <div role="alert" className="text-xs leading-5 text-muted-foreground"><p>{/画幅|尺寸比例/.test(task.error) ? "分层结果尺寸与原图不一致，已保留原图。" : task.error}</p>{/画幅|尺寸比例/.test(task.error) && <details><summary>查看详情</summary>{task.error}</details>}</div>}
      {task.status === "SUCCEEDED" && <><OwnedLayerQualitySummary task={task} /><button type="button" className={control} data-testid="owned-layer-compare-toggle" aria-expanded={comparisonId === task.requestId} onClick={() => setComparisonId(value => value === task.requestId ? null : task.requestId)}>{comparisonId === task.requestId ? "收起原图对照与图层" : "查看原图对照与图层"}</button></>}
      {comparisonId === task.requestId && task.layers.length > 0 && <><OwnedLayerComparison key={`${workspaceId}:${projectId}:${task.requestId}`} task={task} workspaceId={workspaceId} projectId={projectId} userId={userId} /><div className="grid grid-cols-2 gap-2">{task.layers.map(layer => {
        const label = layer.name || `图层 ${layer.order + 1}`;
        // No pixel reaches the visible-ink threshold: the model returned an
        // almost empty layer. Keep it (never drop real pixels) but say so.
        const faint = layer.inkCoverage === 0;
        const item = document?.items.find(value => value.kind === "image" && value.assetId === layer.assetId && value.assetSha256 === layer.assetSha256 && !value.hidden);
        return <div key={layer.assetId} className={"min-w-0 space-y-2 rounded-xl bg-muted p-2" + (faint ? " opacity-60" : "")} data-faint={faint || undefined}><p className="truncate text-xs text-muted-foreground" title={label}>{label}{faint && <span className="ml-1 rounded-full bg-background px-1.5">几乎透明</span>}</p>
          <button type="button" className={control + " w-full !px-2"} aria-label={`进一步分层：${label}`} disabled={!item || readOnly || busy || pending || blocked} onClick={() => { if (item) { setRefineSourceId(item.id); setLayerMode("AUTO"); setNotice(`已选择${label}。确认拆分后才会调用模型，原图层与其他图层仍保留。`); } }}>进一步分层</button></div>;
      })}</div>{task.layers.some(layer => layer.inkCoverage === 0) && <p className="text-xs leading-5 text-muted-foreground" data-testid="owned-layer-faint-note">标记为“几乎透明”的图层基本没有可见内容，可以在画布上隐藏或删除，不影响其他图层。</p>}<p className="text-xs leading-5 text-muted-foreground">展开到画布后，可选择其中一个图层继续细拆。</p></>}
      {task.status === "SUCCEEDED" && <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={readOnly || busy} onClick={() => void place(task)}>展开图片图层</button>
        {api && <button type="button" className={control} disabled={busy} onClick={() => void download(task)} data-testid="owned-layer-psd-download">下载 PSD</button>}
      </div>}
      {task.status === "SUCCEEDED" && backgroundRepair && (() => {
        let reason = backgroundRepair.reason;
        if (!reason) { try { requireOwnedLayerRepairSource(document, task, projectId); } catch (error) { reason = message(error); } }
        if (!reason && readOnly) reason = "当前项目为只读，可检查图层，不能提交背景修复。";
        if (!reason && backgroundRepair.pending) reason = "请先到任务记录确认上一份操作，再修复背景。";
        return <div className="space-y-2 rounded-xl bg-muted p-3" data-testid="owned-layer-repair">
          <button type="button" className={control} data-testid="owned-layer-repair-open" disabled={!backgroundRepair.available || !!reason || readOnly || busy || pending || blocked} onClick={() => void repair(task)}>修复原图背景</button>
          <p className="text-xs leading-5 text-muted-foreground">在原图上涂抹主体和需移除的投影，另存背景修复版本。遮挡处由模型推断，需检查纹理与结构；现有图层保留。</p>
          {reason && <p className="text-xs leading-5 text-muted-foreground" data-testid="owned-layer-repair-reason">{reason}</p>}
        </div>;
      })()}
      {task.canRetryArchive && <button type="button" className={control} disabled={readOnly || busy} onClick={() => void retryArchive(task)}>检查并保存已有结果</button>}
      {task.status === "FAILED" && !task.canRetryArchive && (() => {
        // Retry only preselects the same image and settings; the paid call
        // still needs the explicit submit button below the options.
        const original = document?.items.find(item => item.id === task.sourceShapeId && item.kind === "image" && item.assetId === task.assetId && item.assetSha256 === task.assetSha256);
        return <button type="button" className={control} data-testid="owned-layer-retry" disabled={!original || readOnly || busy || pending || blocked}
          title={original ? undefined : "原图片已不在画布上，请重新选择图片后分层。"}
          onClick={() => { if (!original) return; setRefineSourceId(original.id); setLayerMode(task.layerMode); if (task.layerMode === "MANUAL") setLayerCount(task.layerCount);
            setNotice("已选好原图和原设置。点“开始 AI 分层”才会重新提交，会再次使用分层额度。"); }}>用同样设置重新分层</button>;
      })()}
    </article>;
  const taskGroups = partitionOwnedLayerTasks(tasks);
  return <section className="space-y-4" aria-label="AI 分层" data-testid="owned-layer-panel">
    <div><h2 className="text-sm font-semibold">{refining ? "进一步分层" : "AI 分层"}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">拆成可分别移动、缩放的透明图片图层，原图保留。文字仍是图片，不能直接改字。{layerMode === "AUTO" ? "会额外使用内容分析与分层服务额度。" : "会使用分层服务额度。"}</p></div>
    <p className="text-xs leading-5 text-muted-foreground" data-testid="owned-layer-source">{sourceError || (refining ? `已选择${sourceLayer?.name || "已保存图层"}，只拆分这一个图层，其余图层保留。` : "已选择图片。原图和全部结果分别保存，完成后由你展开。")}</p>
    {refineSourceId && source && <div className="flex items-center gap-3 rounded-2xl border border-border p-3"><img src={source.url} alt="进一步分层的对象" className="h-14 w-14 shrink-0 rounded-lg bg-muted object-contain" /><button type="button" className={control} disabled={pending || busy} onClick={() => setRefineSourceId(null)}>返回画布选中对象</button></div>}
    <details className="space-y-3"><summary className="cursor-pointer text-xs text-muted-foreground">精细设置 · 分层方式与说明</summary>
    <OwnedLayerOptions mode={layerMode} count={layerCount} context="分层" disabled={readOnly || busy || pending || blocked} onMode={setLayerMode} onCount={setLayerCount} />
    <textarea aria-label="分层说明" className="min-h-24 w-full rounded-2xl border border-border bg-background p-3 text-sm" placeholder="可选：优先拆分主体、文字和背景…" maxLength={500} value={intent} disabled={readOnly || busy || pending || blocked} onChange={event => setIntent(event.target.value)} />
    {intent.trim() && <p className="text-xs leading-5 text-muted-foreground">说明用于内容规划，实际图层分组仍需核对。</p>}
    </details>
    <button type="button" className="w-full rounded-full bg-primary py-3 text-sm text-primary-foreground disabled:opacity-40" data-testid="owned-layer-submit" disabled={!api || readOnly || busy || blocked || !pending && !!sourceError} onClick={() => void submit()}>{busy ? "正在确认…" : pending ? "检查上次分层" : refining ? "进一步分层" : "开始 AI 分层"}</button>
    {!!notice && !tasks.some(task => task.error && notice.includes(task.error)) && <p role="status" className="rounded-xl bg-accent-soft p-3 text-xs leading-6" data-testid="owned-layer-notice">{notice}</p>}
    {(blocked || tasks.some(task => ["PENDING", "RUNNING"].includes(task.status) && Date.parse(task.expiresAt) <= Date.now())) && <button type="button" className={control} disabled={reading || busy} onClick={() => void refresh()}>检查分层状态</button>}
    {!tasks.length && <p className="py-4 text-center text-xs text-muted-foreground">当前项目还没有分层任务。</p>}
    {taskGroups.current.map(renderTask)}
    {taskGroups.history.length > 0 && <details className="space-y-3" data-testid="owned-layer-history"><summary className="cursor-pointer text-xs text-muted-foreground">历史任务（{taskGroups.history.length}）</summary><p className="text-xs text-muted-foreground">以下是过去的结果和错误，不代表本次任务状态。</p>{taskGroups.history.map(renderTask)}</details>}
  </section>;
}
