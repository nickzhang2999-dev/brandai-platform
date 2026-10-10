"use client";

import { useEffect, useRef, useState } from "react";
import type { createOwnedEditorApi, GenerationTask, GenerationCompliance, PersistentImage } from "./owned-editor-api";

type Props = { task: GenerationTask; api: ReturnType<typeof createOwnedEditorApi> | null; canEdit: boolean;
  onTask(task: GenerationTask): void; onNotice(message: string): void; onInsert(image: PersistentImage): Promise<void> };
const button = "rounded-full border border-border px-3 py-2 text-xs disabled:opacity-40";
const explain = (error: unknown) => error instanceof Error ? error.message : "任务尚未确认，请刷新后继续。";
const imageKey = (image: GenerationTask["results"][number]) => image.versionId + ":" + image.assetSha256;

/** Reads only existing receipts. Archive/check retries are separate explicit
 * actions and never submit another image-generation request. */
export function OwnedGenerationCard({ task, api, canEdit, onTask, onNotice, onInsert }: Props) {
  const alive = useRef(false), running = useRef(false), latest = useRef({ task, api, canEdit });
  latest.current = { task, api, canEdit };
  const [busy, setBusy] = useState(false), [checks, setChecks] = useState<Record<string, GenerationCompliance>>({});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
    <h3 className="line-clamp-2 text-xs font-semibold">{task.displayText}</h3>
    {task.mode === "modify" && <p className="text-xs text-muted-fg">整图修改 · 原图保留</p>}
    <p className="text-xs leading-5 text-muted-fg">{task.status === "FAILED" ? task.error : task.resultState === "READY" ? "图片已生成并保存" : task.resultState === "FAILED" ? task.archiveError || "生成结果保存失败" : task.status === "SUCCEEDED" ? "生成完成，正在保存图片" : task.status === "RUNNING" ? "正在生成…" : "已受理，排队中"}</p>
    {task.canRetryArchive && <button type="button" className={button} disabled={!canEdit || busy} onClick={() => void action(retryArchive)}>重试保存结果</button>}
    {task.resultState === "READY" && task.results.map(image => {
      const check = checks[imageKey(image)];
      const label = !check ? "尚未读取品牌检查" : check.status === "FAILED" ? check.error : check.status === "NOT_REQUESTED" ? "图片尚未检查" : check.status === "SUCCEEDED" ? "品牌检查：" + (check.report?.overall === "PASS" ? "通过" : check.report?.overall === "RISK" ? "建议复核" : "需要调整") : "品牌检查处理中 · " + check.progress + "%";
      return <div className="space-y-2" key={image.versionId} data-version-id={image.versionId}>
        <img src={image.url} alt="生成结果" className="max-h-52 w-full rounded-xl object-contain" loading="lazy" />
        <button type="button" className={button} disabled={!canEdit || busy} onClick={() => void action(() => onInsert(image))}>加入画布</button>
        <p className="text-xs leading-5 text-muted-fg" data-testid="owned-compliance-status">{label}</p>
        {!!check?.report && <ul className="space-y-1 text-xs">{[...check.report.textResults, ...check.report.visualResults].map((issue, index) => <li key={index}>{issue.reason}{issue.replacement ? " · 建议：" + issue.replacement : ""}</li>)}</ul>}
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !api} onClick={() => void action(() => inspect(image))}>读取品牌检查</button>
          {check?.canRetry && <button type="button" className={button} disabled={busy || !canEdit} onClick={() => void action(() => inspect(image, true))}>{check.status === "NOT_REQUESTED" ? "开始品牌检查" : "重试品牌检查"}</button>}
        </div>
      </div>;
    })}
  </section>;
}
