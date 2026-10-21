"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { StudioCopywritingInput, StudioCopywritingList, StudioCopywritingTask, type StudioCopywritingResult } from "@brandai/contracts";
import type { OwnedCanvasItem } from "@/lib/owned-canvas-model";
type Props = { workspaceId: string; projectId: string; userId: string; readOnly: boolean; selected: OwnedCanvasItem[];
  onInsert(text: string, receiptId: string, anchorId?: string): Promise<void>; onActivity?(busy: boolean): void };
const button = "rounded-full border border-border px-3 py-2 text-xs hover:bg-muted disabled:opacity-40";
const active = (task: StudioCopywritingTask) => task.status === "PENDING" || task.status === "RUNNING";
export function OwnedCopywritingPanel(props: Props) {
  const [prompt, setPrompt] = useState(""), [source, setSource] = useState(""), [mode, setMode] = useState<"GENERATE" | "REWRITE">("GENERATE");
  const [tone, setTone] = useState<StudioCopywritingInput["tone"]>("自然"), [withImage, setWithImage] = useState(true);
  const [tasks, setTasks] = useState<StudioCopywritingTask[]>([]), [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [inserting, setInserting] = useState(false);
  const pending = useRef<StudioCopywritingInput | null>(null), busy = useRef(false), mounted = useRef(false), pollBusy = useRef(false), receiptRevision = useRef(0);
  const latest = useRef(props); latest.current = props;
  const endpoint = `/api/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/studio-copywriting`;
  const journal = `deepflare:copywriting-pending:${JSON.stringify([props.userId, props.workspaceId, props.projectId])}`;
  const image = props.selected.find(item => item.kind === "image" && item.assetId && item.assetSha256);
  const text = props.selected.filter(item => item.kind === "text").map(item => item.text || "").join("\n");
  const running = tasks.some(active);
  const read = useCallback(async () => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    const revision = receiptRevision.current;
    try {
      const response = await fetch(endpoint, { headers: { "X-Novart-User": props.userId }, cache: "no-store", signal: AbortSignal.timeout(12000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "文案记录读取失败。");
      const state = StudioCopywritingList.parse(data); if (!mounted.current || revision !== receiptRevision.current) return;
      setTasks(state.tasks); setEnabled(state.enabled); setReady(true); setError("");
      if (pending.current && state.tasks.some(task => task.mutationId === pending.current?.mutationId)) {
        pending.current = null; setUncertain(false); try { localStorage.removeItem(journal); } catch { /* Server receipt is authoritative. */ }
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error && e.name === "Error" ? e.message : "文案状态暂时读取失败，可点击刷新记录；不会重复调用模型。"); }
    finally { pollBusy.current = false; }
  }, [endpoint, props.userId, journal]);
  useEffect(() => {
    mounted.current = true;
    try { const saved = localStorage.getItem(journal); if (saved) { pending.current = StudioCopywritingInput.parse(JSON.parse(saved)); setUncertain(true); setPrompt(pending.current.prompt); } }
    catch { setError("上次文案提交记录无法读取，请先刷新服务器记录。"); }
    void read();
    return () => { mounted.current = false; };
  }, [journal, read]);
  useEffect(() => { latest.current.onActivity?.(running || uncertain); }, [running, uncertain]);
  useEffect(() => {
    if (!running && !uncertain) return;
    const until = Date.now() + 7 * 60_000;
    const timer = setInterval(() => { if (Date.now() < until) void read(); else { clearInterval(timer); setError("等待时间较长，任务记录仍保留，请点击刷新记录查看。"); } }, 3000);
    return () => clearInterval(timer);
  }, [running, uncertain, read]);
  async function submit() {
    if (busy.current || props.readOnly || !ready || !enabled || running) return;
    busy.current = true; setSending(true); setError(""); setNotice("");
    try {
      if (!pending.current) {
        pending.current = StudioCopywritingInput.parse({ mutationId: crypto.randomUUID(), prompt, mode, sourceText: mode === "REWRITE" ? source : "", tone,
          ...(withImage && image ? { image: { assetId: image.assetId, assetSha256: image.assetSha256 } } : {}) });
        try { localStorage.setItem(journal, JSON.stringify(pending.current)); } catch { pending.current = null; throw new Error("浏览器无法保存提交凭据，请释放本地存储后重试。"); }
      }
      setUncertain(true);
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Novart-User": props.userId }, body: JSON.stringify(pending.current), signal: AbortSignal.timeout(12000) });
      const data = await response.json();
      if (!response.ok) {
        if ([400, 401, 403, 409, 422, 429].includes(response.status)) { pending.current = null; localStorage.removeItem(journal); setUncertain(false); }
        throw new Error(data.error || "提交结果暂未确认，请刷新记录或确认上次提交。");
      }
      const task = StudioCopywritingTask.parse(data);
      if (!mounted.current) return;
      receiptRevision.current++;
      setTasks(current => [task, ...current.filter(item => item.id !== task.id)].slice(0, 20));
      pending.current = null; localStorage.removeItem(journal); setUncertain(false);
    } catch (e) { if (mounted.current) setError(e instanceof Error && e.name === "Error" ? e.message : "请检查输入；若请求已发出，可刷新记录确认结果。"); }
    finally { busy.current = false; if (mounted.current) setSending(false); }
  }
  async function insert(candidate: StudioCopywritingResult["candidates"][number], id: string) {
    if (inserting || props.readOnly) return;
    setInserting(true); setNotice("");
    try { await props.onInsert(`${candidate.title}\n${candidate.body}`, id, props.selected[0]?.id); setNotice("文案已加入画布，可双击编辑，也可以撤销。"); }
    catch (e) { setError(e instanceof Error ? e.message : "加入画布失败，文案仍保留。"); }
    finally { setInserting(false); }
  }
  return <div className="space-y-4" data-testid="copywriting-panel" data-selected-count={props.selected.length} data-selected-text-length={text.length}>
    <p className="text-xs leading-6 text-muted-foreground">写出标题和正文，挑选后加入画布，文字可继续编辑。</p>
    <div className="flex flex-wrap gap-2">{([['GENERATE', '生成文案'], ['REWRITE', '改写文字']] as const).map(([value, label]) => <button key={value} className={button + (mode === value ? " bg-accent-soft text-primary" : "")} aria-pressed={mode === value} disabled={sending || uncertain} onClick={() => setMode(value)}>{label}</button>)}</div>
    {mode === "REWRITE" && <div className="text-xs"><div>原文{text && <button className="ml-2 text-primary underline" disabled={props.readOnly || uncertain} onClick={() => setSource(text.slice(0,4000))}>使用选中文字</button>}</div><textarea aria-label="待改写原文" className="mt-2 min-h-24 w-full rounded-2xl border border-border bg-background p-3 text-sm" value={source} maxLength={4000} disabled={props.readOnly || uncertain} onChange={e=>setSource(e.target.value)} /></div>}
    <label className="block text-xs">文案需求<textarea aria-label="文案需求" className="mt-2 min-h-28 w-full rounded-2xl border border-border bg-background p-3 text-sm" placeholder="例如：为这张海报写一组温暖、有记忆点的标题和介绍" value={prompt} maxLength={2000} disabled={props.readOnly || uncertain} onChange={e=>setPrompt(e.target.value)} /></label>
    <div className="flex flex-wrap items-center justify-between gap-2"><label className="text-xs">语气 <select aria-label="文案语气" className="rounded-full border border-border bg-background p-2" value={tone} disabled={uncertain} onChange={e=>setTone(e.target.value as typeof tone)}>{["自然", "简洁", "活泼", "专业"].map(value=><option key={value}>{value}</option>)}</select></label>{image && <label className="text-xs"><input type="checkbox" checked={withImage} disabled={uncertain} onChange={e=>setWithImage(e.target.checked)} /> 参考所选图片</label>}</div>
    {ready && !enabled && <p role="status" className="text-xs">文案模型尚未配置，请管理员完成接入。</p>}
    {error && <p role="alert" className="text-xs leading-6">{error}</p>}{notice && <p role="status" className="text-xs leading-6">{notice}</p>}
    <button className="w-full rounded-full bg-primary px-4 py-3 text-sm text-primary-foreground disabled:opacity-40" disabled={props.readOnly || sending || running || !ready || !enabled || (!uncertain && (!prompt.trim() || (mode === "REWRITE" && !source.trim())))} onClick={()=>void submit()}>{sending ? "正在提交…" : running ? "文案生成中…" : uncertain ? "确认上次提交" : "生成文案"}</button>
    <p className="text-xs text-muted-foreground">每次生成会调用文案模型；加入画布不再调用模型。</p>
    <div className="flex items-center justify-between"><h3 className="text-sm font-medium">文案记录</h3><button className={button} onClick={()=>void read()}>刷新记录</button></div>
    {tasks.map(task=><article key={task.id} className="space-y-3 rounded-2xl border border-border p-3" data-testid="copywriting-task"><p className="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>{active(task) ? <p role="status" className="text-sm">{task.status === "PENDING" ? "等待生成，离开页面后也会继续。" : "正在写文案…"}</p> : task.status === "FAILED" ? <p role="alert" className="text-xs leading-6">{task.error}</p> : task.result?.candidates.map((candidate,index)=><div key={index} className="space-y-2 border-t border-border pt-3"><h4 className="text-sm font-semibold">{candidate.title}</h4><p className="whitespace-pre-wrap text-sm leading-6">{candidate.body}</p><button className={button} disabled={props.readOnly || inserting} onClick={()=>void insert(candidate, `${task.id}-${index}`)}>加入画布</button></div>)}</article>)}
  </div>;
}
