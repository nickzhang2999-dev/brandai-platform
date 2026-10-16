"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { createOwnedEditorApi, GenerationTask, GenerationCompliance, PersistentImage, GeneratedPsdTask, DecompositionTask } from "./owned-editor-api";
import { downloadOwnedPsd } from "./owned-psd-download";
import { ownedPsdSelection, ownedLayerTaskStatus, ownedLayerTaskTitle } from "./owned-layer-options";
import { useBoundedTaskPoll } from "../../lib/use-bounded-task-poll";

type Props = { task: GenerationTask; api: ReturnType<typeof createOwnedEditorApi> | null; canEdit: boolean;
  compact?: boolean; activityNotice?: string; recoveryDisabled?: boolean; onReedit?(): void;
  onTask(task: GenerationTask): void; onNotice(message: string): void; onInsert(image: PersistentImage): Promise<void>;
  onInsertLayers?(task: DecompositionTask, source: PersistentImage): Promise<void> };
const button = "rounded-full border border-border px-3 py-2 text-xs disabled:opacity-40";
const explain = (error: unknown) => error instanceof Error ? error.message : "任务尚未确认，请刷新后继续。";
const imageKey = (image: GenerationTask["results"][number]) => image.versionId + ":" + image.assetSha256;

/** Reads only existing receipts. Archive/check retries are separate explicit
 * actions and never submit another image-generation request. */
export function OwnedGenerationCard({ task, api, canEdit, onTask, onNotice, onInsert, onInsertLayers, compact = false, activityNotice, recoveryDisabled = false, onReedit }: Props) {
  const selection = ownedPsdSelection(task);
  const alive = useRef(false), running = useRef(false), latest = useRef({ task, api, canEdit });
  latest.current = { task, api, canEdit };
  const [busy, setBusy] = useState(false), [checks, setChecks] = useState<Record<string, GenerationCompliance>>({});
  const [psd, setPsd] = useState<GeneratedPsdTask | null>(null), [psdError, setPsdError] = useState(""), [psdReading, setPsdReading] = useState(false);
  const psdReadBusy = useRef(false);
  const psdBudget = useBoundedTaskPoll({ taskKey: selection.requested && api ? JSON.stringify([task.requestId, task.psdLayerCount, task.psdLayerMode]) : null,
    active: !psd || ["PENDING", "RUNNING"].includes(psd.status) });
  const psdPaused = psdBudget.timedOut;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const readPsd = useCallback(async () => {
    const context = latest.current;
    const chosen = ownedPsdSelection(context.task);
    if (!context.api || !chosen.requested || psdReadBusy.current) return;
    psdReadBusy.current = true; setPsdReading(true);
    try {
      const receipt = await context.api.getGeneratedPsd(context.task.requestId, Math.max(1, Math.min(20000, psdBudget.remaining())));
      if (!alive.current || latest.current.api !== context.api || latest.current.task.requestId !== context.task.requestId) return;
      if (receipt.decomposition && ((receipt.decomposition.layerMode ?? "MANUAL") !== chosen.mode
        || chosen.mode === "MANUAL" && receipt.decomposition.layerCount !== chosen.count)) throw new Error("PSD 拆分方式与本次创作不一致，请刷新确认。");
      setPsd(receipt); setPsdError("");
    } catch (error) {
      if (alive.current && latest.current.api === context.api && latest.current.task.requestId === context.task.requestId) setPsdError(explain(error));
    } finally {
      if (latest.current.api === context.api && latest.current.task.requestId === context.task.requestId) { psdReadBusy.current = false; if (alive.current) setPsdReading(false); }
    }
  }, [psdBudget.remaining]);
  useEffect(() => {
    psdReadBusy.current = false; setPsd(null); setPsdError("");
    if (selection.requested && api) void readPsd();
  }, [task.requestId, task.psdLayerCount, task.psdLayerMode, selection.requested, api, readPsd]);
  useEffect(() => {
    if (!selection.requested || !api || !psd || !["PENDING", "RUNNING"].includes(psd.status) || psdError || psdPaused || psdReading) return;
    const remaining = psdBudget.remaining();
    if (remaining <= 0) return;
    const timer = setTimeout(() => { if (!psdBudget.expired()) void readPsd(); }, Math.min(2500, remaining));
    return () => clearTimeout(timer);
  }, [selection.requested, api, psd, psdError, psdPaused, psdReading, readPsd, psdBudget.remaining, psdBudget.expired]);
  async function refreshPsd() { psdBudget.resume(); await readPsd(); }
  async function expandPsd() {
    const context = latest.current, decomposition = psd?.decomposition;
    if (!context.canEdit || !decomposition || psd?.status !== "READY" || !onInsertLayers) return;
    const source = context.task.results.find(image => image.assetId === decomposition.assetId && image.assetSha256 === decomposition.assetSha256);
    if (!source) throw new Error("PSD 原图与当前生成结果不一致，请刷新确认，图片仍保留。");
    await onInsertLayers(decomposition, source);
  }
  async function downloadPsd() {
    const context = latest.current, decomposition = psd?.decomposition;
    if (!context.api || psd?.status !== "READY" || !decomposition) return;
    const source = context.task.results.find(image => image.assetId === decomposition.assetId && image.assetSha256 === decomposition.assetSha256);
    if (!source) throw new Error("PSD 原图与当前生成结果不一致，未下载文件，请刷新确认。");
    await downloadOwnedPsd(context.api, decomposition);
    if (alive.current && latest.current.api === context.api) onNotice("PSD 已下载，原图和图层仍保留。");
  }
  async function action(work: () => Promise<void>) {
    if (!alive.current || running.current) return;
    running.current = true; setBusy(true);
    try { await work(); } catch (error) { if (alive.current) onNotice(explain(error)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function retryArchive() {
    const context = latest.current;
    if (!context.api || !context.canEdit || !context.task.canRetryArchive) return;
    const updated = await context.api.retryArchive(context.task.requestId);
    if (!alive.current || latest.current.api !== context.api) return;
    if (updated.mutationId !== context.task.mutationId) throw new Error("归档记录与原任务不一致，请刷新确认。");
    onTask(updated); onNotice("已重新保存生成结果，不会再次生成图片。");
  }
  async function inspect(image: GenerationTask["results"][number], retry = false) {
    const context = latest.current;
    if (!context.api || retry && (!context.canEdit || !checks[imageKey(image)]?.canRetry)) return;
    const receipt = await context.api.readCompliance(image.versionId, retry);
    if (!alive.current || latest.current.api !== context.api) return;
    if (!latest.current.task.results.some(result => result.versionId === image.versionId && result.assetSha256 === image.assetSha256)
      || receipt.status === "SUCCEEDED" && receipt.checkedImageSha256 !== image.assetSha256) throw new Error("检查的图片与当前结果不一致，请保留图片并刷新确认。");
    setChecks(current => ({ ...current, [imageKey(image)]: receipt }));
    if (retry) onNotice("已受理品牌检查，图片保留；不会重新生成图片。");
  }
  return <section className="space-y-2 rounded-2xl border border-border p-3" data-task-id={task.requestId} data-task-mode={task.mode}>
    {!compact && <h3 className="line-clamp-2 text-xs font-semibold">{task.displayText}</h3>}
    {!compact && task.mode === "modify" && <p className="text-xs text-muted-foreground">整图修改 · 原图保留</p>}
    {compact && task.status === "FAILED" ? <div className="space-y-2">
      <p role="alert" className="text-xs leading-6">{task.error?.startsWith("生成服务") ? task.error.split("。")[0] + "。" : "本次" + (task.mode === "modify" ? "修改" : "生成") + "未完成。"}{task.mode === "modify" ? "原图已保留。" : "需求已保留。"}</p>
      <div className="flex flex-wrap items-start gap-3 text-xs"><details className="min-w-0 flex-1"><summary className="cursor-pointer text-muted-foreground">查看详情</summary><p className="mt-2 break-words leading-6 text-muted-foreground">{task.error || "具体原因尚未确认，请查看任务状态。"}</p></details>{onReedit && <button type="button" className="rounded-full text-primary disabled:opacity-40" disabled={!canEdit || recoveryDisabled} onClick={onReedit}>重新编辑</button>}</div>
    </div> : <p role={task.resultState === "FAILED" ? "alert" : undefined} className="text-xs leading-5 text-muted-foreground">{task.status === "FAILED" ? task.error : task.resultState === "READY" ? "图片已生成并保存" : task.resultState === "FAILED" ? task.archiveError || "生成结果保存失败" : activityNotice ? activityNotice : task.status === "SUCCEEDED" ? "生成完成，正在保存图片" : compact && task.status === "RUNNING" ? (task.progress === null ? "正在创作…" : `正在创作 · ${task.progress}%`) : task.status === "RUNNING" ? "正在生成…" : "已受理，排队中"}</p>}
    {task.canRetryArchive && <button type="button" className={button} disabled={!canEdit || busy} onClick={() => void action(retryArchive)}>重试保存结果</button>}
    {selection.requested && <details open={compact ? undefined : true} className="space-y-2 rounded-xl bg-accent-soft p-3" data-testid="owned-generated-psd" data-status={psd?.status ?? "LOADING"}>
      <summary hidden={!compact} className="cursor-pointer text-xs">PSD 与图层{psd?.status === "READY" ? " · 已就绪" : psd?.status === "FAILED" ? " · 未完成" : " · 准备中"}</summary>
      <p className="text-xs font-semibold">可编辑 PSD · {psd?.decomposition ? ownedLayerTaskTitle(psd.decomposition) : selection.mode === "AUTO" ? "按内容自动分层" : `${selection.count} 层`}</p>
      <p role="status" className="text-xs leading-5 text-muted-foreground" data-testid="owned-generated-psd-status">{psdError || (psdPaused ? "自动读取已暂停，任务仍在后台处理；可刷新确认。" : psd?.status === "READY" ? "图层已保存，可展开编辑或导出 PSD；导出时会校验文件大小与资源限制。" : psd?.status === "FAILED" ? (psd.error || "PSD 准备未完成。") + " 生成图片仍保留。" : psd?.decomposition ? ownedLayerTaskStatus(psd.decomposition) + "，原图可以先使用。" : psd?.status === "RUNNING" ? "正在准备可编辑图层，原图可以先使用。" : psd?.status === "NOT_REQUESTED" ? "服务端尚未确认 PSD 请求，请刷新任务。" : "PSD 已请求，图片生成保存后将在后台准备。")}</p>
      {psd?.decomposition?.analysisSummary && <p className="text-xs leading-5 text-muted-foreground">{psd.decomposition.analysisSummary}</p>}
      <div className="flex flex-wrap gap-2">
        {psd?.status === "READY" && psd.downloadUrl && <button type="button" className={button + " bg-card"} disabled={!api || busy} onClick={() => void action(downloadPsd)} data-testid="owned-generated-psd-download">下载 PSD</button>}
        {psd?.status === "READY" && onInsertLayers && <button type="button" className={button + " bg-card"} disabled={!canEdit || busy} onClick={() => void action(expandPsd)}>展开为可编辑图层</button>}
        <button type="button" className={button + " bg-card"} disabled={!api || psdReading} onClick={() => void refreshPsd()}>{psdReading ? "正在读取 PSD…" : "刷新 PSD 进度"}</button>
      </div>
    </details>}
    {task.resultState === "READY" && task.results.map(image => {
      const check = checks[imageKey(image)];
      const label = !check ? "尚未读取品牌检查" : check.status === "FAILED" ? check.error : check.status === "NOT_REQUESTED" ? "图片尚未检查" : check.status === "SUCCEEDED" ? "品牌检查：" + (check.report?.overall === "PASS" ? "通过" : check.report?.overall === "RISK" ? "建议复核" : "需要调整") : "品牌检查处理中 · " + check.progress + "%";
      return <div className="space-y-2" key={image.versionId} data-version-id={image.versionId}>
        <img src={image.url} alt="生成结果" className="max-h-52 w-full rounded-xl object-contain" loading="lazy" />
        <button type="button" className={button} disabled={!canEdit || busy} onClick={() => void action(() => onInsert(image))}>加入画布</button>
        <details open={compact ? undefined : true}>
        <summary hidden={!compact} className="cursor-pointer text-xs text-muted-foreground">品牌检查</summary>
        <p className="text-xs leading-5 text-muted-foreground" data-testid="owned-compliance-status">{label}</p>
        {!!check?.report && <ul className="space-y-1 text-xs">{[...check.report.textResults, ...check.report.visualResults].map((issue, index) => <li key={index}>{issue.reason}{issue.replacement ? " · 建议：" + issue.replacement : ""}</li>)}</ul>}
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !api} onClick={() => void action(() => inspect(image))}>读取品牌检查</button>
          {check?.canRetry && <button type="button" className={button} disabled={busy || !canEdit} onClick={() => void action(() => inspect(image, true))}>{check.status === "NOT_REQUESTED" ? "开始品牌检查" : "重试品牌检查"}</button>}
        </div>
        </details>
      </div>;
    })}
  </section>;
}
