"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@brandai/ui";
import { StudioWritingState, StudioWritingSaveResult, StudioWritingGenerateInput, StudioWritingTask,
  StudioWritingTaskLookup, StudioWritingReferenceAccepted, StudioWritingStyle, StudioWritingStyleSaveInput,
  StudioWritingStyleExtractInput, StudioWritingMessages, StudioWritingVersions, STUDIO_WRITING_FILE_MAX_BYTES, type StudioWritingDocument,
  type StudioWritingSaveInput } from "@brandai/contracts";
import { captureSelection, selectionIsCurrent, writingFetch, writingScope, type WritingSelection } from "./writing-state";
import styles from "./writing-workbench.module.css";

export type WritingWorkbenchProps = { workspaceId: string; projectId: string; userId: string; readOnly: boolean; projectName: string;
  initialPrompt?: string; initialTaskId?: string; onSendToCanvas?(document: { documentId: string; revision: number; title: string; text: string }): Promise<void>;
  onReturnToCanvas?(): void };
export type WritingWorkbenchHandle = { restoreHome(prompt: string, requestId: string): void; ready(): boolean; refresh(): Promise<void>;
  confirmLeave(): Promise<void>; selectReferences(ids: string[]): void };
type Pending = { kind: "generate" | "style" | "upload"; mutationId: string; input?: StudioWritingGenerateInput | ReturnType<typeof StudioWritingStyleExtractInput.parse> };
type Draft = { revision: number; title: string; text: string };
const isActive = (task: StudioWritingTask) => task.status === "PENDING" || task.status === "RUNNING";
const buttonClass = "rounded-full";
const selectionOf = (task: StudioWritingTask): WritingSelection | null => task.input && "mode" in task.input && task.input.selection
  ? { ...task.input.selection, revision: task.input.expectedRevision } : null;
const message = (error: unknown) => error instanceof Error && error.name === "ZodError" ? "输入或返回格式不符合要求，请检查文字长度和所选资料后重试。" : error instanceof Error && error.name !== "AbortError" ? error.message : "连接暂未确认，请核对状态。你的内容仍保留。";

function Drawer({ title, onClose, children, feedback }: { title: string; onClose(): void; children: ReactNode; feedback?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href],summary') || []);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); before?.focus(); };
  }, [onClose]);
  return <div className={styles.overlay} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={styles.drawer} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.drawerHeader}><h2>{title}</h2><Button variant="ghost" size="sm" onClick={onClose} aria-label={`关闭${title}`}>关闭</Button></div>{feedback}{children}
    </div>
  </div>;
}

export const WritingWorkbench = forwardRef<WritingWorkbenchHandle, WritingWorkbenchProps>(function WritingWorkbench(props, forwardedRef) {
  const endpoint = `/api/workspaces/${encodeURIComponent(props.workspaceId)}/projects/${encodeURIComponent(props.projectId)}/studio-writing`;
  const scope = writingScope(props.userId, props.workspaceId, props.projectId);
  const [state, setState] = useState<StudioWritingState | null>(null), [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState(""), [text, setText] = useState(""), [prompt, setPrompt] = useState(props.initialPrompt || "");
  const [selectedIds, setSelectedIds] = useState<string[]>([]), [useStyle, setUseStyle] = useState(true);
  const [selection, setSelection] = useState<WritingSelection | null>(null), [mode, setMode] = useState<StudioWritingGenerateInput["mode"]>("GENERATE");
  const [drawer, setDrawer] = useState<"references" | "versions" | "style" | null>(null), [tab, setTab] = useState<"chat" | "document">("chat");
  const [pending, setPending] = useState<Pending | null>(null), [working, setWorking] = useState(false), [uploading, setUploading] = useState<string[]>([]);
  const [pendingNotFound, setPendingNotFound] = useState(false);
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(""), [conflict, setConflict] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [recovery, setRecovery] = useState<Draft | null>(null);
  const [styleRules, setStyleRules] = useState(""), [styleExamples, setStyleExamples] = useState<StudioWritingStyle["examples"]>([]);
  const [styleBase, setStyleBase] = useState(0), [stylePreview, setStylePreview] = useState<StudioWritingTask | null>(null);
  const [styleOpened, setStyleOpened] = useState(false);
  const [versionPreview, setVersionPreview] = useState<string | null>(null);
  const [linkedTask, setLinkedTask] = useState<StudioWritingTask | null>(null), [linkedTaskError, setLinkedTaskError] = useState("");
  const linkedTaskNode = useRef<HTMLElement | null>(null), linkedTaskLocated = useRef(false);
  const [earlierMessages, setEarlierMessages] = useState<StudioWritingState["messages"]>([]), [earlierVersions, setEarlierVersions] = useState<StudioWritingState["versions"]>([]);
  const [historyTasks, setHistoryTasks] = useState<StudioWritingTask[]>([]), [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const [messagesEnded, setMessagesEnded] = useState(false), [versionsEnded, setVersionsEnded] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null), alive = useRef(false), loaded = useRef(false), reading = useRef(false);
  const mutationEpoch = useRef(0), readAgain = useRef(false);
  const server = useRef<StudioWritingDocument | null>(null), edit = useRef({ title: "", text: "" });
  const stateRef = useRef(state), busy = useRef(false), saveBusy = useRef(false), pendingRef = useRef<Pending | null>(null);
  const saveErrorRef = useRef(""), conflictRef = useRef(false), promptRef = useRef(prompt), restoredHome = useRef<string | null>(null);
  stateRef.current = state; pendingRef.current = pending; promptRef.current = prompt; saveErrorRef.current = saveError; conflictRef.current = conflict;
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const recoveryRef = useRef(recovery); recoveryRef.current = recovery;
  const dirty = !!state && (title !== state.document.title || text !== state.document.text);
  const styleDirty = !!state && styleOpened && (styleRules !== state.style.rules.join("\n") || JSON.stringify(styleExamples) !== JSON.stringify(state.style.examples));
  const leaveBlocked = useRef(false); leaveBlocked.current = !!pending || !!recovery || !!uploading.length || styleDirty;
  const headers = useMemo(() => ({ "Content-Type": "application/json", "X-Novart-User": props.userId }), [props.userId]);
  const documentReady = !!state;
  const activeHistoryKey = JSON.stringify(historyTasks.filter(isActive).map(task => task.id).sort());
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const journal = useCallback((key: string, value: unknown) => {
    try { if (value === null) localStorage.removeItem(scope + key); else localStorage.setItem(scope + key, JSON.stringify(value)); return true; }
    catch { setError("浏览器暂时无法保留恢复记录，请先保存并勿关闭页面。"); return false; }
  }, [scope]);
  function updateEdit(next: { title: string; text: string }) {
    edit.current = next; setTitle(next.title); setText(next.text);
    if (server.current && !props.readOnly) journal(":draft", { revision: server.current.revision, ...next });
  }
  const acceptDocument = useCallback((document: StudioWritingDocument, replace = false) => {
    mutationEpoch.current++;
    server.current = document;
    setState(current => current ? { ...current, document } : current);
    if (replace) { edit.current = { title: document.title, text: document.text }; setTitle(document.title); setText(document.text); setSelection(null); setMode("GENERATE"); }
  }, []);
  const read = useCallback(async () => {
    if (reading.current) { readAgain.current = true; return; }
    reading.current = true;
    const epoch = mutationEpoch.current;
    try {
      const next = StudioWritingState.parse(await writingFetch(endpoint, { headers: { "X-Novart-User": props.userId } }));
      if (!alive.current) return;
      if (epoch !== mutationEpoch.current) { readAgain.current = true; return; }
      if (server.current && next.document.revision < server.current.revision) next.document = server.current;
      setLoadError("");
      if (!loaded.current) {
        loaded.current = true; server.current = next.document;
        let initial: Draft | null = null;
        try { initial = JSON.parse(localStorage.getItem(scope + ":draft") || "null"); } catch { }
        if (initial && typeof initial.text === "string" && typeof initial.title === "string" && initial.text.length <= 60000 && initial.title.length <= 200 && !props.readOnly && (initial.text !== next.document.text || initial.title !== next.document.title)) {
          // Recovery is always reviewed against the authoritative server document.
          recoveryRef.current = initial; setRecovery(initial);
        }
        edit.current = { title: next.document.title, text: next.document.text }; setTitle(next.document.title); setText(next.document.text);
        try {
          const composer = JSON.parse(localStorage.getItem(scope + ":composer") || "null");
          if (composer && typeof composer.prompt === "string") setPrompt(composer.prompt.slice(0, 4000));
          const home = JSON.parse(localStorage.getItem(scope + ":home") || "null");
          if (home && typeof home.requestId === "string") { restoredHome.current = home.requestId; if (!composer && typeof home.prompt === "string") setPrompt(home.prompt.slice(0, 4000)); }
          if (Array.isArray(composer?.selectedIds)) setSelectedIds(composer.selectedIds.filter((id: unknown) => typeof id === "string" && next.references.some(r => r.id === id)).slice(0, 12));
          const previous = JSON.parse(localStorage.getItem(scope + ":pending") || "null");
          if (previous && ["generate", "style", "upload"].includes(previous.kind) && typeof previous.mutationId === "string") { setPending(previous); pendingRef.current = previous; }
        } catch { setError("浏览器恢复记录无法读取，请核对服务端记录后继续。"); }
      } else if (!saveBusy.current) {
        const changed = server.current && (edit.current.title !== server.current.title || edit.current.text !== server.current.text);
        if (edit.current.text === next.document.text && edit.current.title === next.document.title) {
          server.current = next.document; setConflict(false); conflictRef.current = false; setSaveError(""); if (!recoveryRef.current) journal(":draft", null);
        } else if (changed && server.current?.revision !== next.document.revision) { setConflict(true); conflictRef.current = true; }
        else if (!changed) { server.current = next.document; edit.current = { title: next.document.title, text: next.document.text }; setTitle(next.document.title); setText(next.document.text); }
      }
      if (!saveBusy.current) { stateRef.current = next; setState(next); }
    } catch (e) { if (alive.current) setLoadError(message(e)); }
    finally { reading.current = false; if (readAgain.current && alive.current) { readAgain.current = false; void read(); } }
  }, [endpoint, props.userId, props.readOnly, scope, journal]);

  useEffect(() => {
    alive.current = true; void read();
    const interval = setInterval(() => { if (document.visibilityState === "visible" && stateRef.current?.tasks.some(isActive)) void read(); }, 3000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    const leaving = (event: BeforeUnloadEvent) => {
      const doc = server.current;
      if (leaveBlocked.current || (doc && (edit.current.text !== doc.text || edit.current.title !== doc.title || saveBusy.current))) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", leaving); document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; clearInterval(interval); window.removeEventListener("beforeunload", leaving); document.removeEventListener("visibilitychange", visible); };
  }, [read]);
  useEffect(() => { if (loaded.current) journal(":composer", { prompt, selectedIds }); }, [prompt, selectedIds, journal]); // Composition only; server owns submitted turns.
  useEffect(() => {
    if (!props.initialTaskId) return;
    let cancelled = false, readingTask = false, finished = false;
    linkedTaskLocated.current = false; setLinkedTask(null); setLinkedTaskError("");
    const readTask = async () => {
      if (cancelled || readingTask || finished) return;
      readingTask = true;
      try {
        const task = StudioWritingTask.parse(await writingFetch(`${endpoint}/tasks/${encodeURIComponent(props.initialTaskId!)}`, { headers }));
        if (!cancelled) { setLinkedTask(task); setLinkedTaskError(""); finished = !isActive(task); }
      } catch (e) {
        if (!cancelled) { setLinkedTaskError((e as { status?: number }).status === 404 ? "通知对应的文案任务不存在，或不属于当前账号与项目。" : message(e)); finished = true; }
      } finally { readingTask = false; }
    };
    void readTask();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void readTask(); }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [props.initialTaskId, endpoint, headers]);
  useEffect(() => {
    if (!state || !linkedTask || linkedTaskLocated.current || linkedTask.operation !== "GENERATE") return;
    linkedTaskLocated.current = true; setTab("chat"); linkedTaskNode.current?.scrollIntoView({ block: "nearest" });
  }, [state, linkedTask]);
  useEffect(() => {
    const ids: string[] = JSON.parse(activeHistoryKey); if (!ids.length) return;
    let cancelled = false, polling = false, failed = false;
    const poll = async () => {
      if (cancelled || polling || failed || document.visibilityState !== "visible") return;
      polling = true;
      const results = await Promise.allSettled(ids.map(async id => StudioWritingTask.parse(await writingFetch(`${endpoint}/tasks/${encodeURIComponent(id)}`, { headers }))));
      if (!cancelled) {
        const updated = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
        setHistoryTasks(current => [...new Map([...current, ...updated].map(task => [task.id, task])).values()]);
        if (results.some(result => result.status === "rejected")) { failed = true; setError("历史任务状态暂时无法确认，请点击该轮的‘核对这轮状态’重新读取；不会重新提交模型。"); }
      }
      polling = false;
    };
    const interval = setInterval(() => void poll(), 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeHistoryKey, endpoint, headers]);
  useEffect(() => { if (editor.current) { editor.current.style.height = "auto"; editor.current.style.height = Math.max(560, editor.current.scrollHeight) + "px"; } }, [text, tab]);
  useEffect(() => {
    const element = editor.current; if (!element) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      if (!width || width === previousWidth) return;
      previousWidth = width; element.style.height = "auto"; element.style.height = Math.max(560, element.scrollHeight) + "px";
    });
    observer.observe(element); return () => observer.disconnect();
  }, [documentReady]);
  const save = useCallback(async (operation?: StudioWritingSaveInput): Promise<StudioWritingDocument | null> => {
    if (props.readOnly || !server.current || saveBusy.current || conflictRef.current) return null;
    const captured = { ...edit.current }, before = server.current;
    if (!operation && captured.text === before.text && captured.title === before.title) return before;
    saveBusy.current = true; setSaving(true); setSaveError("");
    try {
      const input = operation || { operation: "SAVE", mutationId: crypto.randomUUID(), expectedRevision: before.revision, ...captured };
      const result = StudioWritingSaveResult.parse(await writingFetch(endpoint, { method: "PUT", headers, body: JSON.stringify(input) }));
      if (!alive.current) return null;
      const unchanged = edit.current.text === captured.text && edit.current.title === captured.title;
      const previousSelection = selectionRef.current;
      acceptDocument(result.document, unchanged);
      if (!operation && unchanged && previousSelection && result.document.text.slice(previousSelection.start, previousSelection.end) === previousSelection.text) setSelection({ ...previousSelection, revision: result.document.revision });
      setState(current => current ? { ...current, versions: [result.version, ...current.versions.filter(v => v.id !== result.version.id)].slice(0, 20) } : current);
      if (unchanged) journal(":draft", null);
      else journal(":draft", { revision: result.document.revision, ...edit.current });
      setConflict(false); conflictRef.current = false; return result.document;
    } catch (e) {
      if (alive.current) { setSaveError(message(e)); if ((e as { status?: number }).status === 409) { setConflict(true); conflictRef.current = true; } }
      return null;
    } finally { saveBusy.current = false; if (alive.current) setSaving(false); }
  }, [props.readOnly, endpoint, headers, acceptDocument, journal]);
  const confirmLeave = useCallback(async () => {
    if (pendingRef.current || busy.current || uploading.length) throw new Error("还有提交或上传结果待核对，请先确认后再离开。");
    if (recovery) throw new Error("还有本机恢复稿待处理，请先选择保留哪一版。");
    if (styleDirty) throw new Error("品牌风格还有未确认修改，请先保存或明确放弃。");
    if (saveBusy.current) throw new Error("正文正在保存，请稍等保存完成。");
    if (props.readOnly) return;
    const saved = await save();
    if (!saved || edit.current.text !== saved.text || edit.current.title !== saved.title) throw new Error("正文尚未保存完成，请核对后再离开。");
  }, [uploading.length, recovery, styleDirty, props.readOnly, save]);

  useImperativeHandle(forwardedRef, () => ({ ready: () => loaded.current, refresh: async () => {
    const deadline = Date.now() + 25000;
    while (reading.current && alive.current && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (reading.current || !alive.current) throw new Error("资料状态暂时无法同步，请稍后重试。");
    await read();
  }, confirmLeave, selectReferences(ids) {
    const references = stateRef.current?.references || [];
    const selected = [...new Set(ids)];
    if (selected.some(id => !references.some(r => r.id === id))) throw new Error("导入资料还未同步，请刷新后重试。");
    let images = 0;
    const chosen = selected.filter(id => { const image = references.find(r => r.id === id)?.kind === "IMAGE"; if (image) images++; return !image || images <= 4; }).slice(0, 12);
    setSelectedIds(chosen);
    if (chosen.length !== selected.length) setNotice("导入资料均已保存，本轮先选前 4 张图片及范围内文档。更多资料可在“资料”里切换选择。每轮最多 12 份。");
    else if (chosen.some(id => references.find(r => r.id === id)?.status !== "READY")) setNotice("导入资料已选入本轮，正在等待解析完成；完成后才能发送需求。");
  }, restoreHome(value, requestId) {
    if (restoredHome.current === requestId) return;
    if (!loaded.current || props.readOnly || pendingRef.current || busy.current || promptRef.current.trim()) throw new Error("当前输入仍有内容，请先核对，首页需求没有被覆盖。");
    if (!value.trim() || value.length > 4000) throw new Error("文案需求长度不符合要求。");
    if (!journal(":home", { requestId, prompt: value }) || !journal(":composer", { prompt: value, selectedIds })) throw new Error("首页需求还未保存到恢复记录，请勿关闭页面。");
    restoredHome.current = requestId; promptRef.current = value; setPrompt(value); setNotice("首页需求已带入，点击发送后才会调用模型。");
  } }), [props.readOnly, read, confirmLeave, journal, selectedIds]);


  useEffect(() => {
    if (!dirty || props.readOnly || saving || saveError || conflict || recovery) return;
    const timer = setTimeout(() => void save(), 1200);
    return () => clearTimeout(timer);
  }, [dirty, title, text, saving, saveError, conflict, recovery, props.readOnly, save]);

  function rememberPending(value: Pending) { if (!journal(":pending", value)) return false; setPendingNotFound(false); pendingRef.current = value; setPending(value); return true; }
  function clearPending() { journal(":pending", null); pendingRef.current = null; setPending(null); setPendingNotFound(false); }
  function addTask(task: StudioWritingTask) { mutationEpoch.current++; setState(current => current ? { ...current, tasks: [task, ...current.tasks.filter(t => t.id !== task.id)].slice(0, 30) } : current); }
  async function recoverPending() {
    if (!pendingRef.current || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try {
      const result = StudioWritingTaskLookup.parse(await writingFetch(`${endpoint}/tasks?mutationId=${encodeURIComponent(pendingRef.current.mutationId)}`, { headers }));
      if (result.task) { addTask(result.task); const input = pendingRef.current?.input; if (input && "mode" in input && promptRef.current.trim() === input.prompt) setPrompt(""); clearPending(); setNotice("已找到原任务，正在同步记录；没有重新提交。"); await read(); }
      else { setPendingNotFound(true); setError("暂未找到这次提交。可以稍后核对；也可明确确认重发原请求，保留相同请求标识。"); }
    } catch (e) { setError(message(e)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function resubmitPending() {
    const previous = pendingRef.current;
    if (!previous || !pendingNotFound || busy.current || props.readOnly || !previous.input) return;
    busy.current = true; setWorking(true); setError("");
    try {
      const input = previous.kind === "generate" ? StudioWritingGenerateInput.parse(previous.input) : StudioWritingStyleExtractInput.parse(previous.input);
      const task = StudioWritingTask.parse(await writingFetch(endpoint + (previous.kind === "style" ? "/style/extract" : ""), { method: "POST", headers, body: JSON.stringify(input) }));
      addTask(task); if ("mode" in input && promptRef.current.trim() === input.prompt) setPrompt(""); clearPending(); await read();
      setNotice("已使用原请求标识确认提交，没有创建第二个请求标识。");
    } catch (e) { if ((e as { status?: number }).status && (e as { status: number }).status < 500) clearPending(); setError(message(e)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault(); if (props.readOnly || busy.current || pendingRef.current || !state || !prompt.trim() || saveBusy.current) return;
    busy.current = true; setWorking(true); setError(""); setNotice("");
    try {
      const capturedText = edit.current.text, capturedTitle = edit.current.title, chosenSelection = selection;
      const current = await save(); if (!current) throw new Error("请先解决正文保存问题，再发送本轮需求。");
      if (edit.current.text !== capturedText || edit.current.title !== capturedTitle) throw new Error("发送前正文又有修改，请保存后重新发送。");
      if (mode === "SELECTION" && (!chosenSelection || capturedText.slice(chosenSelection.start, chosenSelection.end) !== chosenSelection.text)) throw new Error("原选段已变化，请重新选择。");
      const input = StudioWritingGenerateInput.parse({ mutationId: crypto.randomUUID(), expectedRevision: current.revision, prompt,
        mode, referenceIds: selectedIds, styleRevision: useStyle && state.style.confirmedAt ? state.style.revision : null,
        ...(mode === "SELECTION" && chosenSelection ? { selection: { start: chosenSelection.start, end: chosenSelection.end, text: chosenSelection.text } } : {}) });
      if (!rememberPending({ kind: "generate", mutationId: input.mutationId, input })) return;
      const task = StudioWritingTask.parse(await writingFetch(endpoint, { method: "POST", headers, body: JSON.stringify(input) }));
      addTask(task); clearPending(); if (promptRef.current.trim() === input.prompt) setPrompt(""); if (restoredHome.current) journal(":home", { requestId: restoredHome.current, prompt: "" }); setNotice("已受理，结果会保留在对话中；不会自动替换正文。"); await read();
    } catch (e) { if ((e as { status?: number }).status && (e as { status: number }).status < 500) clearPending(); setError(message(e)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function upload(files: FileList | null) {
    if (!files || props.readOnly || busy.current || pendingRef.current) return;
    const list = Array.from(files); busy.current = true; setWorking(true); setError("");
    try {
      for (const file of list) {
        if (file.size > STUDIO_WRITING_FILE_MAX_BYTES) { setError(`${file.name} 超过 10 MiB，未上传。`); continue; }
        if (!/\.(png|jpe?g|webp|txt|md|pdf|docx|pptx)$/i.test(file.name)) { setError(`${file.name} 格式暂不支持。`); continue; }
        const mutationId = crypto.randomUUID();
        if (!rememberPending({ kind: "upload", mutationId })) break;
        setUploading([file.name]);
        const body = new FormData(); body.set("file", file); body.set("mutationId", mutationId);
        const result = StudioWritingReferenceAccepted.parse(await writingFetch(endpoint + "/references", { method: "POST", headers: { "X-Novart-User": props.userId }, body }, 45000));
        clearPending(); addTask(result.task);
        setState(current => current ? { ...current, references: [result.reference, ...current.references.filter(r => r.id !== result.reference.id)] } : current);
      }
      await read(); setNotice("资料已接收；解析完成后勾选，才会用于本轮对话。");
    } catch (e) { if ((e as { status?: number }).status && (e as { status: number }).status < 500) clearPending(); setError(message(e)); }
    finally { setUploading([]); busy.current = false; setWorking(false); }
  }
  async function applyTask(task: StudioWritingTask) {
    if (!task.result || props.readOnly || busy.current || saveBusy.current || dirty) { setError("请先保存当前手改内容，再核对建议。"); return; }
    const chosen = selectionOf(task);
    if (!server.current || task.result.baseRevision !== server.current.revision || (chosen && !selectionIsCurrent(chosen, edit.current.text, server.current.revision))) { setError("正文已变化，这条建议已过时。请基于当前稿重新提问；你的手改没有被覆盖。"); return; }
    if (task.result.scope === "SELECTION" && chosen) {
      const result = await save({ operation: "REPLACE", mutationId: crypto.randomUUID(), expectedRevision: server.current.revision,
        selection: { start: chosen.start, end: chosen.end, text: chosen.text }, replacement: task.result.text });
      if (result) { setNotice("已仅替换原选段，并保存为新版本。"); setTab("document"); }
    } else if (task.result.scope === "DOCUMENT") {
      updateEdit({ title: edit.current.title || props.projectName, text: task.result.text });
      if (await save()) { setNotice("已设为当前稿，之前的保存版本仍可恢复。"); setTab("document"); }
    }
  }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); setNotice("已复制。"); } catch { setError("剪贴板不可用，请选中文字手动复制。"); } }
  async function restore(versionId: string) {
    if (dirty || saveBusy.current || !server.current) { setError("请先保存当前修改，再恢复历史版本。"); return; }
    if (await save({ operation: "RESTORE", mutationId: crypto.randomUUID(), expectedRevision: server.current.revision, versionId })) { setNotice("已恢复为新版本，历史记录仍保留。"); setVersionPreview(null); closeDrawer(); }
  }
  function openStyle() { if (!state) return; if (!styleDirty) { setStyleRules(state.style.rules.join("\n")); setStyleExamples(state.style.examples); setStyleBase(state.style.revision); setStylePreview(null); } setStyleOpened(true); setDrawer("style"); }
  async function saveStyle() {
    if (props.readOnly || busy.current) return; busy.current = true; setWorking(true); setError("");
    try {
      const input = StudioWritingStyleSaveInput.parse({ mutationId: crypto.randomUUID(), expectedRevision: styleBase, confirmed: true,
        rules: styleRules.split("\n").map(line => line.trim()).filter(Boolean), examples: styleExamples.filter(e => e.title.trim() || e.text.trim()) });
      const value = StudioWritingStyle.parse(await writingFetch(endpoint + "/style", { method: "PUT", headers, body: JSON.stringify(input) }));
      mutationEpoch.current++; setState(current => current ? { ...current, style: value } : current); setStyleBase(value.revision); setStylePreview(null); setNotice("品牌风格已确认保存，可在后续对话复用。");
    } catch (e) { setError(message(e)); } finally { busy.current = false; setWorking(false); }
  }
  async function extractStyle() {
    if (props.readOnly || busy.current || pendingRef.current) return; busy.current = true; setWorking(true); setError("");
    try {
      const input = StudioWritingStyleExtractInput.parse({ mutationId: crypto.randomUUID(), referenceIds: selectedIds, prompt: "从选用资料中总结可复用的文案语气、句式与表达偏好；只提出建议，等待用户确认。" });
      if (!rememberPending({ kind: "style", mutationId: input.mutationId, input })) return;
      const task = StudioWritingTask.parse(await writingFetch(endpoint + "/style/extract", { method: "POST", headers, body: JSON.stringify(input) }));
      addTask(task); clearPending(); setNotice("已提交风格提取；完成后先预览，确认前不会替换品牌风格。");
    } catch (e) { if ((e as { status?: number }).status && (e as { status: number }).status < 500) clearPending(); setError(message(e)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function handoff() {
    if (props.readOnly || busy.current || !props.onSendToCanvas) return;
    try { await confirmLeave(); } catch (e) { setError(message(e)); return; }
    const saved = await save(); if (!saved || !saved.text.trim()) return;
    busy.current = true; setWorking(true);
    try { await props.onSendToCanvas({ documentId: saved.id, revision: saved.revision, title: saved.title, text: saved.text }); setNotice("当前稿已送回画布。"); } catch (e) { setError(message(e)); }
    finally { busy.current = false; setWorking(false); }
  }
  const references = state?.references || [], selectedRefs = references.filter(r => selectedIds.includes(r.id));
  const tasks = [...new Map([...historyTasks, ...(state?.tasks || []), ...(linkedTask ? [linkedTask] : [])].map(task => [task.id, task])).values()];
  const activeTasks = tasks.filter(isActive), generated = tasks.filter(t => t.operation === "GENERATE");
  const messages = [...new Map([...earlierMessages, ...(state?.messages || [])].map(item => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const versions = [...new Map([...earlierVersions, ...(state?.versions || [])].map(item => [item.id, item])).values()].sort((a, b) => b.revision - a.revision);
  const turns = [...new Set([...generated.map(task => task.id), ...messages.map(item => item.taskId)])].map(id => {
    const task = generated.find(item => item.id === id), records = messages.filter(item => item.taskId === id);
    return { id, task, records, createdAt: task?.createdAt || records[0]?.createdAt || "" };
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  async function loadHistory(kind: "messages" | "versions" | "task", taskId?: string) {
    if (historyLoading) return; setHistoryLoading(kind === "task" ? taskId! : kind); setError("");
    try {
      if (kind === "task" && taskId) {
        const task = StudioWritingTask.parse(await writingFetch(`${endpoint}/tasks/${encodeURIComponent(taskId)}`, { headers }));
        setHistoryTasks(current => [task, ...current.filter(item => item.id !== task.id)]);
      } else if (kind === "messages") {
        const beforeId = messages[0]?.id;
        const page = StudioWritingMessages.parse(await writingFetch(`${endpoint}/messages${beforeId ? `?beforeId=${encodeURIComponent(beforeId)}` : ""}`, { headers }));
        setEarlierMessages(current => [...new Map([...page.messages, ...current].map(item => [item.id, item])).values()]); setMessagesEnded(!page.hasMore);
      } else if (kind === "versions") {
        const beforeRevision = versions.at(-1)?.revision;
        const page = StudioWritingVersions.parse(await writingFetch(`${endpoint}/versions${beforeRevision ? `?beforeRevision=${beforeRevision}` : ""}`, { headers }));
        setEarlierVersions(current => [...new Map([...page.versions, ...current].map(item => [item.id, item])).values()]); setVersionsEnded(!page.hasMore);
      }
    } catch (e) { setError(message(e)); } finally { setHistoryLoading(null); }
  }
  const chooseReference = (id: string, checked: boolean) => setSelectedIds(current => checked ? [...current, id].slice(0, 12) : current.filter(value => value !== id));
  const stageText = (task: StudioWritingTask) => task.status === "FAILED" ? task.error || "处理失败，请检查资料或调整需求。" : new Date(task.expiresAt).getTime() < Date.now() ? "处理时间较长，请刷新核对原任务。不会自动重试。" : task.status === "PENDING" ? "已受理，等待处理…" : `正在处理 ${task.progress}%…`;
  const feedback = <>{error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.status}>{notice}</p>}</>;

  return <main className={styles.workbench} data-testid="writing-workbench" data-ready={!!state} data-save-state={saving ? "saving" : conflict ? "conflict" : dirty ? "dirty" : "saved"}>
    <header className={styles.header}><div><p className={styles.eyebrow}>NOVART / WRITING</p><h1>文案工作台</h1><p className={styles.subtle}>{props.projectName} · 从想法，到一篇可用的文案</p></div>
      <div className={styles.actions}>{props.onReturnToCanvas && <Button variant="ghost" size="sm" className={buttonClass} onClick={() => { void confirmLeave().then(() => props.onReturnToCanvas?.()).catch(e => setError(message(e))); }}>返回画布</Button>}<Button variant="ghost" size="sm" className={buttonClass} onClick={() => setDrawer("references")}>资料 {references.length || ""}</Button><Button variant="ghost" size="sm" className={buttonClass} onClick={openStyle} disabled={!state}>品牌风格</Button>
        <a className="text-xs text-muted-foreground hover:text-primary" href={`/studio?workspaceId=${encodeURIComponent(props.workspaceId)}#/projects`} target="_top" onClick={event => { event.preventDefault(); const href = event.currentTarget.href; void confirmLeave().then(() => { window.top!.location.href = href; }).catch(e => setError(message(e))); }}>返回项目</a></div></header>
    <div className={styles.notice}>{props.readOnly && <p className={styles.readOnly}>只读权限 · 可以阅读与复制，不能提交模型任务或修改内容。</p>}
      {loadError && <p role="alert" className={styles.error}>{loadError} <Button variant="ghost" size="sm" onClick={() => void read()}>重新读取</Button></p>}
      {linkedTaskError && <p role="alert" className={styles.error}>{linkedTaskError}</p>}
      {linkedTask && <p className={styles.status}>已读取通知中的文案任务。<Button variant="ghost" size="sm" onClick={() => { if (linkedTask.operation === "STYLE_EXTRACT") openStyle(); else if (linkedTask.operation === "REFERENCE_PARSE") setDrawer("references"); else { setTab("chat"); linkedTaskNode.current?.scrollIntoView({ block: "nearest" }); } }}>查看通知结果</Button></p>}
      {!drawer && error && <p role="alert" className={styles.error}>{error}</p>}{!drawer && notice && <p role="status" className={styles.status}>{notice}</p>}
      {pending && <div className={styles.warning}>上次提交的结果尚未确认。先查原任务，避免重复调用。<Button variant="outline" size="sm" className={buttonClass} disabled={working} onClick={() => void recoverPending()}>核对上次提交</Button>{pendingNotFound && pending.input && <Button variant="outline" size="sm" disabled={working || props.readOnly} onClick={() => void resubmitPending()}>确认重发原请求</Button>}{pendingNotFound && pending.kind === "upload" && <Button variant="ghost" size="sm" disabled={working || props.readOnly} onClick={() => { clearPending(); setDrawer("references"); setNotice("未找到上传任务，请重新选择原文件。已有资料不会被删除。"); }}>重新选择原文件</Button>}</div>}
      {recovery && <div className={styles.warning}>此浏览器保留了一份未确认保存的正文。服务端当前为版本 {state?.document.revision}，本机记录基于版本 {recovery.revision}。
        <div className={styles.actions}><Button variant="outline" size="sm" disabled={props.readOnly || recovery.revision !== state?.document.revision} onClick={() => { updateEdit({ title: recovery.title, text: recovery.text }); setRecovery(null); setNotice("已恢复本机修改，正在保存。"); }}>恢复未保存修改</Button><Button variant="ghost" size="sm" onClick={() => void copy(recovery.text)}>复制本机稿</Button><Button variant="ghost" size="sm" onClick={() => { journal(":draft", null); setRecovery(null); }}>保留服务端版本</Button></div></div>}
    </div>
    {!state ? <p role="status" className="p-8 text-sm text-muted-foreground">{loadError ? "暂时无法读取文案，内容没有被清空。" : "正在读取文案与对话…"}</p> : <>
      <nav className={styles.mobileTabs} aria-label="工作区切换"><Button variant={tab === "chat" ? "primary" : "outline"} className={buttonClass} onClick={() => setTab("chat")}>对话</Button><Button variant={tab === "document" ? "primary" : "outline"} className={buttonClass} onClick={() => setTab("document")}>当前稿</Button></nav>
      <div className={styles.layout}>
        <section className={`${styles.conversation} ${tab !== "chat" ? styles.mobileHidden : ""}`} aria-label="文案对话">
          <div className={styles.paneTitle}><h2>一起把文案写好</h2><Button variant="ghost" size="sm" onClick={() => void read()}>刷新记录</Button></div>
          <div className={styles.history}>
            {!messagesEnded && (state.messages.length >= 50 || earlierMessages.length > 0) && <Button variant="ghost" size="sm" disabled={!!historyLoading} onClick={() => void loadHistory("messages")}>加载更早对话</Button>}
            {!turns.length && <div className={styles.empty}><h2>你想说什么，<br />我们一起写清楚。</h2><p className={styles.subtle}>告诉我受众、用途和你最想表达的内容。参考资料可以随时补充。</p></div>}
            {turns.map(({ id, task, records }) => <article className={styles.turn} key={id} data-testid="writing-turn" data-task-id={id} ref={id === props.initialTaskId ? node => { linkedTaskNode.current = node; } : undefined}>
              <p className={styles.userMessage}>{task?.input && "mode" in task.input ? task.input.prompt : records.find(m => m.role === "user")?.text || "文案请求"}</p>
              {task && <p className={styles.sourceLine}>本轮资料：{task.input?.referenceIds.length ? task.input.referenceIds.map(id => references.find(r => r.id === id)?.name || "已移除的资料").join("、") : "未选用"}{task.input && "styleRevision" in task.input && task.input.styleRevision !== null ? ` · 品牌风格版本 ${task.input.styleRevision}` : ""}</p>}
              {!task ? <div className={styles.candidate}>{records.filter(item => item.role === "assistant").map(item => <p key={item.id}>{item.text}</p>)}<Button variant="outline" size="sm" disabled={!!historyLoading} onClick={() => void loadHistory("task", id)}>读取这轮完整建议</Button><p className={styles.sourceLine}>读取原任务后可核对来源与正文版本，不会重新调用模型。</p></div> : task.status !== "SUCCEEDED" ? <div><p role={task.status === "FAILED" ? "alert" : "status"} className={styles.status}>{stageText(task)}</p>{isActive(task) && <Button variant="ghost" size="sm" disabled={!!historyLoading} onClick={() => void loadHistory("task", id)}>核对这轮状态</Button>}</div> : task.result && <div className={styles.candidate}>
                <h3>{task.result.scope === "SELECTION" ? "这段可以这样改" : task.result.scope === "CHAT" ? "一起推敲" : "一版新的表达"}</h3>
                {selectionOf(task) && <details className={styles.details}><summary>查看原选段</summary><pre>{selectionOf(task)!.text}</pre></details>}
                <p>{task.result.text}</p>
                {!!task.result.citations.length && <details className={styles.details}><summary>查看引用来源</summary>{task.result.citations.map((c, i) => <p className={styles.sourceLine} key={i}>{references.find(r => r.id === c.referenceId)?.name || "已移除的资料"} · {c.label}{c.pageNumber ? ` · 第 ${c.pageNumber} 页` : ""}</p>)}</details>}
                <div className={styles.actions}><Button variant="ghost" size="sm" onClick={() => void copy(task.result!.text)}>复制建议</Button>{["DOCUMENT", "SELECTION"].includes(task.result.scope) && <Button variant="outline" size="sm" className={buttonClass} disabled={props.readOnly || saving || working || dirty} onClick={() => void applyTask(task)}>{task.result.scope === "SELECTION" ? "采纳选段修改" : "设为当前稿"}</Button>}</div>
                {task.result.baseRevision !== state.document.revision && task.result.scope !== "CHAT" && <p className={styles.sourceLine}>正文版本已变化，采纳前将重新核对。</p>}
              </div>}
            </article>)}
          </div>
          <form className={styles.composer} onSubmit={event => void send(event)}>
            {mode === "SELECTION" && selection && <div className={styles.warning}>正在修改选中的 {selection.text.length} 个字符 <button type="button" className="text-primary underline" onClick={() => { setSelection(null); setMode("GENERATE"); }}>取消选段</button></div>}
            <textarea className={styles.input} aria-label="本轮文案需求" maxLength={4000} value={prompt} readOnly={props.readOnly} onChange={e => setPrompt(e.target.value)} placeholder={mode === "SELECTION" ? "这段想怎么改？例如：保留信息，写得更直接一些。" : "例如：为新品写一篇发布文案，先讲清楚它解决了什么问题。"} />
            {!!selectedRefs.length && <div className={styles.chips}>{selectedRefs.map(r => <span className={styles.chip} key={r.id}>{r.name}{r.status !== "READY" ? " · 未就绪" : ""}</span>)}</div>}
            {state.style.confirmedAt && <label className={styles.subtle}><input type="checkbox" checked={useStyle} onChange={e => setUseStyle(e.target.checked)} disabled={props.readOnly} /> 使用已确认的品牌风格</label>}
            <div className={styles.composerFooter}><Button type="button" variant="ghost" size="sm" onClick={() => setDrawer("references")}>＋ 添加资料</Button><Button type="submit" className={buttonClass} disabled={props.readOnly || !state.enabled || working || saving || !!pending || !prompt.trim() || selectedRefs.some(r => r.status !== "READY") || selectedRefs.filter(r => r.kind === "IMAGE").length > 4}> {working ? "处理中…" : "发送需求"}</Button></div>
          </form>
          <p className={styles.subtle}>{!state.enabled ? "文案模型尚未配置，请联系管理员。" : "点击发送才调用模型。建议先预览，采纳后才改正文。"}</p>
        </section>
        <section className={`${styles.editor} ${tab !== "document" ? styles.mobileHidden : ""}`} aria-label="当前文案">
          <div className={styles.editorToolbar}><div className="min-w-0 flex-1"><label className="sr-only" htmlFor="writing-title">文案标题</label><input id="writing-title" className={styles.titleInput} value={title} maxLength={200} readOnly={props.readOnly} placeholder="当前稿" onChange={e => updateEdit({ ...edit.current, title: e.target.value })} /><p className={styles.subtle}>{saving ? "正在保存…" : conflict ? "版本冲突，手改已保留" : saveError ? "保存尚未确认" : dirty ? "有未保存修改" : `已保存 · 版本 ${state.document.revision}`}</p></div>
            <div className={styles.actions}><Button variant="ghost" size="sm" onClick={() => setDrawer("versions")}>版本记录</Button><Button variant="outline" size="sm" className={buttonClass} disabled={props.readOnly || saving || !dirty || conflict} onClick={() => void save()}>保存正文</Button></div></div>
          {(saveError || conflict) && <div className={styles.selection} role="alert">{saveError || "服务端正文已更新，你的修改仍保留。"}<div className={styles.actions}><Button variant="ghost" size="sm" onClick={() => void copy(text)}>复制当前修改</Button><Button variant="ghost" size="sm" onClick={() => void read()}>核对最新状态</Button>{conflict && <Button variant="outline" size="sm" onClick={() => { if (state) { acceptDocument(state.document, true); setSaveError(""); setConflict(false); conflictRef.current = false; journal(":draft", null); } }}>使用最新服务端稿</Button>}</div></div>}
          {selection && <div className={styles.selection}><strong>已选中 {selection.text.length} 个字符</strong><p className={styles.quote}>{selection.text}</p><Button variant="outline" size="sm" className={buttonClass} disabled={props.readOnly} onClick={() => { setMode("SELECTION"); setTab("chat"); }}>用一句话修改这段</Button></div>}
          <textarea ref={editor} className={styles.body} aria-label="当前稿正文" spellCheck={false} maxLength={60000} value={text} readOnly={props.readOnly} placeholder="文案会在这里展开。你也可以直接粘贴或写下第一段。\n\n选中一句或一段，再告诉我怎么改。" onChange={e => { updateEdit({ ...edit.current, text: e.target.value }); setSelection(null); if (mode === "SELECTION") setMode("GENERATE"); }} onSelect={e => { if (props.readOnly) return; const el = e.currentTarget; if (el.selectionEnd > el.selectionStart) setSelection(captureSelection(el.value, el.selectionStart, el.selectionEnd, server.current?.revision || 0)); }} />
          <div className={styles.editorFooter}><span>{text.length.toLocaleString()} 字符 · 选中文字可局部修改</span><div className={styles.actions}><button type="button" className="text-primary" disabled={!text} onClick={() => void copy(text)}>复制全文</button><button type="button" className="text-primary disabled:opacity-40" disabled={props.readOnly || !text.trim() || working || saving || !props.onSendToCanvas} onClick={() => void handoff()}>送回画布</button></div></div>
        </section>
      </div>
      {drawer === "references" && <Drawer title="本轮参考资料" onClose={closeDrawer} feedback={feedback}><p className={styles.subtle}>支持多张图片、TXT、Markdown、PDF、DOCX、PPTX，每份最多 10 MiB。上传不会自动调用模型，解析完成后再勾选本轮资料（最多 12 份，其中图片最多 4 张）。</p><p className={styles.subtle}>生成会按当前问题选用部分文字片段，单份最多 6000 字符；未引用不代表已读完整文件。文档解析不执行 OCR。</p>
        {!props.readOnly && <label className={styles.field}>补充资料<input aria-label="上传文案参考资料" type="file" multiple accept="image/png,image/jpeg,image/webp,.txt,.md,.pdf,.docx,.pptx" disabled={working || !!pending || references.length >= 30} onChange={e => { void upload(e.target.files); e.target.value = ""; }} /></label>}
        {uploading.map(name => <p key={name} role="status" className={styles.status}>正在上传 {name}…</p>)}
        {!references.length && <p className={styles.subtle}>还没有参考资料。可以先对话，之后随时补充。</p>}
        {references.map(r => <article key={r.id} className={styles.row}><h3><label><input type="checkbox" checked={selectedIds.includes(r.id)} disabled={props.readOnly || (!selectedIds.includes(r.id) && (r.status !== "READY" || selectedIds.length >= 12))} onChange={e => chooseReference(r.id, e.target.checked)} /> {r.name}</label></h3><p className={styles.subtle}>{r.kind === "IMAGE" ? "图片" : "文档"} · {r.status === "READY" ? `可使用 · ${r.kind === "DOCUMENT" ? `${r.segments.length} 个文本片段` : "随本轮需求发送所选图片"}` : r.status === "FAILED" ? "解析失败" : "正在解析…"}</p>
          {r.status === "FAILED" && <p role="alert" className={styles.error}>{r.error || "未能提取文字，请检查文件或改用 TXT / MD。"}</p>}
          {r.truncated && <p className={styles.warning}>仅提取前 6 万字符，超出部分未读取；未执行 OCR。</p>}
          {["PENDING", "RUNNING"].includes(r.status) && <progress aria-label={`${r.name} 解析进度`} />}
          {r.segments.length > 0 && <details className={styles.details}><summary>查看提取内容与来源</summary>{r.segments.slice(0, 12).map(s => <div key={s.id}><p className={styles.sourceLine}>{s.label}{s.pageNumber ? ` · 第 ${s.pageNumber} 页` : ""}</p><pre>{s.text}</pre></div>)}</details>}
        </article>)}<p className={styles.subtle}>本轮已选 {selectedIds.length} 份资料，{selectedRefs.filter(r => r.kind === "IMAGE").length} 张图片。</p>{selectedRefs.filter(r => r.kind === "IMAGE").length > 4 && <p role="alert" className={styles.error}>每轮最多选 4 张图片，请减少图片后发送。</p>}
      </Drawer>}
      {drawer === "versions" && <Drawer title="正文版本记录" onClose={closeDrawer} feedback={feedback}><p className={styles.subtle}>恢复会生成新版本，旧版本继续保留。先保存当前修改，再恢复。</p>{!versions.length && <p className={styles.subtle}>第一次保存正文后，会在这里保留版本。</p>}{versions.map(v => <article key={v.id} className={styles.row}><h3>版本 {v.revision} · {v.operation === "REPLACE" ? "选段修改" : v.operation === "RESTORE" ? "历史恢复" : "正文保存"}</h3><p className={styles.subtle}>{new Date(v.createdAt).toLocaleString("zh-CN")} · {v.text.length} 字符</p><Button variant="ghost" size="sm" onClick={() => setVersionPreview(versionPreview === v.id ? null : v.id)}>查看版本 {v.revision}</Button>{versionPreview === v.id && <><p>{v.text}</p><Button variant="outline" size="sm" disabled={props.readOnly || dirty || saving || v.revision === state.document.revision} onClick={() => void restore(v.id)}>恢复为当前稿</Button></>}</article>)}{!versionsEnded && (versions.at(-1)?.revision || 0) > 1 && <Button variant="ghost" size="sm" disabled={!!historyLoading} onClick={() => void loadHistory("versions")}>加载更早版本</Button>}</Drawer>}
      {drawer === "style" && <Drawer title="品牌文案风格" onClose={closeDrawer} feedback={feedback}><p className={styles.subtle}>确认的规则会在后续对话复用。模型只提出风格草案，由你决定是否采用。</p>
        <label className={styles.field}>表达规则 · 每行一条<textarea aria-label="品牌表达规则" value={styleRules} readOnly={props.readOnly} onChange={e => setStyleRules(e.target.value)} placeholder="例如：先说清用户收益；用短句，避免夸张承诺。" /></label>
        {styleExamples.map((example, index) => <div className={styles.row} key={index}><label className={styles.field}>范文标题<input type="text" aria-label={`范文 ${index + 1} 标题`} value={example.title} readOnly={props.readOnly} maxLength={100} onChange={e => setStyleExamples(items => items.map((item, i) => i === index ? { ...item, title: e.target.value } : item))} /></label><label className={styles.field}>范文正文<textarea aria-label={`范文 ${index + 1} 正文`} value={example.text} readOnly={props.readOnly} maxLength={6000} onChange={e => setStyleExamples(items => items.map((item, i) => i === index ? { ...item, text: e.target.value } : item))} /></label><Button variant="ghost" size="sm" disabled={props.readOnly} onClick={() => setStyleExamples(items => items.filter((_, i) => i !== index))}>移除范文 {index + 1}</Button></div>)}
        <div className={styles.actions}><Button variant="outline" size="sm" disabled={props.readOnly || styleExamples.length >= 5} onClick={() => setStyleExamples(items => [...items, { title: "", text: "" }])}>添加范文</Button><Button className={buttonClass} disabled={props.readOnly || working} onClick={() => void saveStyle()}>确认并保存风格</Button>{styleDirty && <Button variant="ghost" size="sm" onClick={() => { setStyleRules(state.style.rules.join("\n")); setStyleExamples(state.style.examples); setStyleBase(state.style.revision); setStylePreview(null); }}>放弃风格修改</Button>}</div>
        <div className={styles.row}><h3>让模型提取风格</h3><p className={styles.subtle}>使用本轮勾选的资料。此按钮会调用模型，先生成草案，不自动修改已确认的风格。</p><Button variant="outline" size="sm" disabled={props.readOnly || !state.enabled || working || !!pending || !selectedIds.length || selectedRefs.some(r => r.status !== "READY")} onClick={() => void extractStyle()}>从所选资料提取风格</Button></div>
        {tasks.filter(t => t.operation === "STYLE_EXTRACT").map(task => <div className={styles.row} key={task.id}>{task.result?.styleDraft ? <><h3>待确认的风格草案</h3><Button variant="ghost" size="sm" onClick={() => setStylePreview(task)}>预览这份风格草案</Button></> : <p role="status" className={styles.subtle}>{stageText(task)}</p>}</div>)}
        {stylePreview?.result?.styleDraft && <div className={styles.warning}><strong>风格预览 · 尚未采用</strong><ul className="my-3 list-disc pl-4">{stylePreview.result.styleDraft.rules.map((rule, i) => <li key={i}>{rule}</li>)}</ul>{stylePreview.result.styleDraft.examples.map((example, i) => <p key={i}>{example.title}：{example.text}</p>)}<Button variant="outline" size="sm" disabled={props.readOnly} onClick={() => { setStyleRules(stylePreview.result!.styleDraft!.rules.join("\n")); setStyleExamples(stylePreview.result!.styleDraft!.examples); setStylePreview(null); setNotice("草案已放入编辑区，确认保存后才生效。"); }}>放入编辑区再确认</Button></div>}
      </Drawer>}
    </>}
    {!!activeTasks.length && <div className="sr-only" role="status">{activeTasks.length} 个任务处理中，离开页面后仍由服务端继续。</div>}
  </main>;
});
