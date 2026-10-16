"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { StudioMaterial } from "@brandai/contracts";
import { StudioBrandMaterialsPage, StudioBrandMaterialVerification, StudioBrandMaterialUploadView, type StudioBrandMaterialEntry } from "../../../../../packages/contracts/src/studio-brand-materials";
import { NovartApiError } from "../../lib/novart-api-client";
import { useBoundedTaskPoll, TASK_POLL_PAUSED_MESSAGE } from "../../lib/use-bounded-task-poll";

export type OwnedBrandMaterialsDrawerProps = {
  workspaceId: string; projectId: string; userId: string; readOnly?: boolean;
  onInsert: (material: StudioMaterial) => Promise<void> | void;
  onReference: (material: StudioMaterial) => Promise<void> | void;
  onClose: () => void;
};
const button = "rounded-full border border-border bg-card px-3 py-2 text-xs text-fg hover:bg-muted disabled:opacity-40";
const pending = (status: string) => status === "PENDING" || status === "RUNNING";

/** Real BFF-backed brand library. Selection is distinct from canvas insertion
 * and conversation references; closing never deletes an uploaded Asset. */
export function OwnedBrandMaterialsDrawer({ workspaceId, projectId, userId, readOnly = false, onInsert, onReference, onClose }: OwnedBrandMaterialsDrawerProps) {
  const [items, setItems] = useState<StudioBrandMaterialEntry[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState(""), [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [tasks, setTasks] = useState<z.infer<typeof StudioBrandMaterialUploadView>[]>([]);
  const lifetime = useRef<AbortController | null>(null), root = useRef<HTMLElement | null>(null), searchInput = useRef<HTMLInputElement | null>(null), fileInput = useRef<HTMLInputElement | null>(null);
  const lock = useRef(false), sequence = useRef(0);
  const uploadPoll = useBoundedTaskPoll({ taskKey: JSON.stringify([workspaceId, userId]), active: tasks.some(task => pending(task.status)) });
  const uploadAttempt = useRef<{ file: File; mutationId: string } | null>(null);
  const prefix = `/api/workspaces/${encodeURIComponent(workspaceId)}/studio-brand-materials`;

  const request = useCallback(async <T,>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init: RequestInit = {}): Promise<T> => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) throw new Error("素材抽屉已关闭。");
    const writing = init.method === "POST";
    try {
      const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store",
        headers: { ...init.headers, "X-Novart-User": userId }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      const body = await response.json();
      if (!response.ok) throw new NovartApiError(typeof body?.error === "string" ? body.error : "素材请求未完成。", response.status, undefined, writing && response.status >= 500);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new NovartApiError("素材回执不完整，请重新打开确认。", response.status, "INVALID_RECEIPT", writing);
      return parsed.data;
    } catch (error) {
      if (error instanceof NovartApiError) throw error;
      throw new NovartApiError("素材连接中断，请刷新确认已受理的任务。", null, undefined, writing);
    }
  }, [userId]);
  const materialScope = useCallback((material: StudioMaterial) => {
    if (material.url !== `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(material.assetId)}/raw`)
      throw new Error("图片回执不属于当前品牌。");
    return material;
  }, [workspaceId]);
  const refresh = useCallback(async (nextCursor?: string) => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "24", ...(search.trim() ? { search: search.trim() } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
      const page = await request(prefix + "?" + query, StudioBrandMaterialsPage);
      if (current !== sequence.current || lifetime.current?.signal.aborted) return;
      page.items.forEach(item => { if (item.material) materialScope(item.material); });
      setItems(old => nextCursor ? [...old, ...page.items.filter(item => !old.some(value => value.assetId === item.assetId))] : page.items);
      setCursor(page.nextCursor); setError("");
    } catch (error) { if (current === sequence.current && !lifetime.current?.signal.aborted) setError(error instanceof Error ? error.message : "素材暂时无法读取。"); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [materialScope, prefix, request, search]);
  const uploadUrl = useCallback((taskId?: string) => prefix + "/upload" + (taskId ? "?" + new URLSearchParams({ taskId }) : ""), [prefix]);
  const recoverUploads = useCallback(async () => {
    const data = await request(uploadUrl(), z.object({ tasks: StudioBrandMaterialUploadView.array() }).strict());
    data.tasks.forEach(task => { if (task.workspaceId !== workspaceId) throw new Error("上传回执不属于当前品牌。"); if (task.material) materialScope(task.material); });
    setTasks(data.tasks);
  }, [materialScope, workspaceId, request, uploadUrl]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const before = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    void recoverUploads().catch(() => undefined);
    return () => { controller.abort(); sequence.current += 1; cancelAnimationFrame(frame); before?.focus(); };
  }, [recoverUploads]);
  useEffect(() => { const timer = setTimeout(() => void refresh(), 200); return () => clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    if (!tasks.some(task => pending(task.status)) || uploadPoll.timedOut) return;
    const timer = setTimeout(() => { if (!uploadPoll.expired()) void recoverUploads().then(() => refresh()).catch(error => setError(error instanceof Error ? error.message : "请刷新任务确认。")); }, Math.min(2500, uploadPoll.remaining()));
    return () => clearTimeout(timer);
  }, [recoverUploads, refresh, tasks, uploadPoll.timedOut, uploadPoll.expired, uploadPoll.remaining]);

  const upload = useCallback(async (file: File) => {
    if (readOnly || lock.current) return;
    if (!file.size || file.size > 10 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setError("请选择 10 MiB 以内的 PNG、JPEG 或 WebP 图片。"); return; }
    lock.current = true; setBusy(true); setError(""); setNotice("正在保存图片…");
    try {
      if (uploadAttempt.current && uploadAttempt.current.file !== file) throw new Error("上一张图片的受理结果尚未确认，请先重试原上传或刷新任务。");
      uploadAttempt.current ??= { file, mutationId: crypto.randomUUID() };
      const form = new FormData(); form.set("file", uploadAttempt.current.file);
      form.set("mutationId", uploadAttempt.current.mutationId);
      const task = await request(uploadUrl(), StudioBrandMaterialUploadView, { method: "POST", body: form });
      if (task.workspaceId !== workspaceId || task.mutationId !== uploadAttempt.current.mutationId) throw new NovartApiError("上传回执与当前操作不一致，请刷新确认。", 422, "INVALID_RECEIPT", true);
      uploadAttempt.current = null; uploadPoll.resume();
      setTasks(old => [task, ...old.filter(value => value.taskId !== task.taskId)]);
      if (task.material) { materialScope(task.material); setChosen(task.material.assetId); await refresh(); }
      setNotice(task.status === "SUCCEEDED" ? "图片已保存到品牌素材库，可以选择加入画布或对话。" : "上传已受理，图片会保留在品牌素材库；可以关闭抽屉。" );
    } catch (error) {
      if (error instanceof NovartApiError && !error.uncertain) uploadAttempt.current = null;
      setError(error instanceof Error ? error.message : "上传未完成。");
    } finally { lock.current = false; setBusy(false); }
  }, [materialScope, workspaceId, readOnly, refresh, request, uploadUrl, uploadPoll.resume]);

  const choose = async (kind: "canvas" | "conversation") => {
    if (readOnly || lock.current || !chosen) return;
    lock.current = true; setBusy(true); setError(""); setNotice("正在确认素材…");
    try {
      const endpoint = `${prefix}/${encodeURIComponent(chosen)}`;
      let receipt = await request(endpoint, StudioBrandMaterialVerification, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "verify" }) });
      const started = Date.now();
      while (pending(receipt.status) && Date.now() - started < 90_000) {
        setNotice("正在校验原始图片，原文件保留在素材库。可关闭抽屉后再打开继续。");
        await new Promise<void>((resolve, reject) => {
          const signal = lifetime.current?.signal;
          const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 1500);
          const abort = () => { clearTimeout(timer); reject(new Error("素材抽屉已关闭，后台校验继续。")); };
          if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        });
        receipt = await request(endpoint, StudioBrandMaterialVerification);
      }
      if (receipt.assetId !== chosen || !receipt.material || receipt.status !== "SUCCEEDED") throw new Error(receipt.error ?? "图片仍在校验，请稍后重新选择；原图片没有丢失。");
      const material = materialScope(receipt.material);
      const linked = materialScope(await request(endpoint, StudioMaterial, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "link", projectId, assetSha256: material.assetSha256 }) }));
      if (linked.assetId !== material.assetId || linked.assetSha256 !== material.assetSha256) throw new Error("图片关联回执不一致，未插入画布。");
      if (kind === "canvas") await onInsert(linked); else await onReference(linked);
      setNotice(kind === "canvas" ? "已加入画布。品牌素材仍可在其他项目复用。" : "已加入对话引用。画布选择保持不变。" );
      await refresh();
    } catch (error) { if (!lifetime.current?.signal.aborted) setError(error instanceof Error ? error.message : "图片尚未加入。"); }
    finally { lock.current = false; if (!lifetime.current?.signal.aborted) setBusy(false); }
  };
  const imageFile = (files: FileList | null) => files && Array.from(files).find(file => file.type.startsWith("image/"));

  return <section ref={root} role="dialog" aria-modal="true" aria-label="品牌素材库" data-testid="owned-brand-materials"
    className="flex min-h-0 flex-col rounded-3xl bg-card text-fg" onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const focusable = root.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']");
      if (!focusable?.length) return;
      const first = focusable[0]!, last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={event => {
      event.preventDefault(); event.stopPropagation(); const file = imageFile(event.dataTransfer.files); if (file) void upload(file);
    }} onPaste={event => { const file = imageFile(event.clipboardData.files); if (file) { event.preventDefault(); event.stopPropagation(); void upload(file); } }}>
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">品牌素材库</h2><p className="mt-1 text-xs text-muted-fg">品牌内共享，选择后加入画布或对话。</p></div><button type="button" className={button} aria-label="关闭品牌素材库" onClick={onClose}>关闭</button></div>
    <div className="mt-4 flex gap-2"><input ref={searchInput} aria-label="搜索品牌素材" type="search" placeholder="搜索名称或标签" value={search} maxLength={200} onChange={event => { setSearch(event.target.value); setChosen(""); }} className="min-w-0 flex-1 rounded-full border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-primary" /><button type="button" className={button} disabled={readOnly || busy} onClick={() => fileInput.current?.click()}>上传</button></div>
    <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void upload(file); }} />
    <div className="mt-3 text-xs leading-5" aria-live="polite">{notice && <p>{notice}</p>}{error && <p role="alert" className="text-danger">{error}</p>}
      {uploadPoll.timedOut && <p role="status">{TASK_POLL_PAUSED_MESSAGE} 点击下方“刷新”继续读取原上传。</p>}
      {uploadAttempt.current && <button type="button" className="underline" disabled={busy} onClick={() => { const operation = uploadAttempt.current; if (operation) void upload(operation.file); }}>确认原上传回执</button>}
      {tasks.filter(task => task.status !== "SUCCEEDED").map(task => <p key={task.taskId}>{pending(task.status) ? `图片保存中 · ${task.progress}%` : task.error ?? "上传未完成"}</p>)}</div>
    <div className="mt-3 max-h-[55vh] min-h-0 overflow-y-auto" data-testid="owned-brand-material-list"><div className="grid grid-cols-2 gap-3">
      {items.map(item => <button key={item.assetId} type="button" aria-label={`选择素材 ${item.fileName}`} aria-pressed={chosen === item.assetId} disabled={busy}
        className={`overflow-hidden rounded-2xl border p-2 text-left ${chosen === item.assetId ? "border-primary bg-accent-soft" : "border-border bg-card"}`} onClick={() => { setChosen(item.assetId); setError(""); }}>
        <img src={item.url} alt={item.fileName} loading="lazy" className="aspect-square w-full rounded-xl object-contain" /><span className="mt-2 block truncate text-xs" title={item.fileName}>{item.fileName}</span>
        <span className="text-[11px] text-muted-fg">{item.material ? `${item.material.width} × ${item.material.height}` : "使用前校验原图"}</span>
      </button>)}
    </div>{!items.length && !loading && <p className="py-8 text-center text-xs text-muted-fg">{search ? "没有匹配素材" : "上传第一张品牌素材，多个项目都能复用。"}</p>}
      {loading && <p className="py-4 text-center text-xs text-muted-fg">正在读取素材…</p>}{cursor && <button type="button" className={`${button} mt-4 w-full`} disabled={loading} onClick={() => void refresh(cursor)}>加载更多</button>}</div>
    <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4"><button type="button" className={button} disabled={readOnly || busy || !chosen} onClick={() => void choose("canvas")}>加入画布</button><button type="button" className={button} disabled={readOnly || busy || !chosen} onClick={() => void choose("conversation")}>加入对话</button><button type="button" className={button} disabled={loading} onClick={() => { uploadPoll.resume(); void recoverUploads().then(() => refresh()).catch(error => setError(error instanceof Error ? error.message : "任务暂不可读。")); }}>刷新</button></div>
    {readOnly && <p className="mt-2 text-xs text-muted-fg">当前项目只读，可以浏览品牌素材。</p>}
  </section>;
}
