"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StudioConversationInput, StudioConversationMessage, type StudioConversationDraftInput, type StudioConversationReference, type StudioConversationMessage as Message } from "@brandai/contracts";
import type { z } from "zod";
import { NovartApiError } from "../../lib/novart-api-client";
import { createOwnedConversationApi } from "./owned-conversation-api";
import { mergeOwnedConversationReferences, ownedConversationDraftEqual } from "./owned-conversation-references";
import { OwnedGenerationCard } from "./OwnedGenerationCard";
import type { createOwnedEditorApi, DecompositionTask, GenerationTask, PersistentImage } from "./owned-editor-api";

type Draft = Omit<StudioConversationDraftInput, "revision">;
type Input = z.infer<typeof StudioConversationInput>;
export type OwnedConversationHandle = { flush(): Promise<void>; confirmed(): boolean; addReferences(refs: StudioConversationReference[], quickEditTargetId?: string): void; quickEdit(ref: StudioConversationReference, text: string): Promise<void> };
type Props = { workspaceId: string; projectId: string; userId: string; readOnly: boolean;
  api: ReturnType<typeof createOwnedEditorApi> | null;
  prepare(): Promise<{ documentRevision: number; workflowRevision: number; outputFrameId?: string }>;
  onNotice(message: string): void; onGeneration(task: GenerationTask): void; onInsert(image: PersistentImage, sourceShapeId?: string): Promise<void>;
  onInsertLayers(task: DecompositionTask, source: PersistentImage): Promise<void> };
const button = "rounded-full border border-border px-3 py-2 text-xs disabled:opacity-40";
const empty = (): Draft => ({ text: "", references: [], quickEditTargetId: null, sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } });
const draftValue = (value: StudioConversationDraftInput): Draft => ({ text: value.text, references: value.references, quickEditTargetId: value.quickEditTargetId, sizeSelection: value.sizeSelection });
const same = ownedConversationDraftEqual;
const active = (message: Message) => ["PENDING", "RUNNING"].includes(message.status) || !!message.generation && ["NOT_REQUESTED", "PENDING", "RUNNING"].includes(message.generation.resultState);
const explain = (error: unknown) => error instanceof Error ? error.message : "对话暂未确认，原需求仍保留。";

/** A persistent conversation UI, separate from the technical workflow controls.
 * Local storage is only an unacknowledged mutation journal; server state is authoritative. */
export const OwnedConversationPanel = forwardRef<OwnedConversationHandle, Props>(function OwnedConversationPanel(props, ref) {
  const latest = useRef(props); latest.current = props;
  const [draft, setDraft] = useState<Draft>(empty), draftRef = useRef(draft), confirmedDraft = useRef<Draft | null>(null), revision = useRef(0);
  const [messages, setMessages] = useState<Message[]>([]), messagesRef = useRef<Message[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false), readyRef = useRef(false), [error, setError] = useState(""), [saving, setSaving] = useState(false), [sending, setSending] = useState(false);
  const [unknown, setUnknown] = useState(false), [paused, setPaused] = useState(false), mounted = useRef(false), composing = useRef(false), input = useRef<HTMLTextAreaElement>(null);
  const api = useRef<ReturnType<typeof createOwnedConversationApi> | null>(null), saveBusy = useRef(false), sendBusy = useRef(false), pollBusy = useRef(false);
  const pending = useRef<Input | null>(null), saveSnapshot = useRef<StudioConversationDraftInput | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null), history = useRef<HTMLDivElement>(null), follow = useRef(true);
  const journalKey = `deepflare:conversation-pending:${JSON.stringify([props.userId, props.workspaceId, props.projectId])}`;
  const keyRef = useRef(journalKey); keyRef.current = journalKey;
  const updateDraft = useCallback((value: Draft) => { draftRef.current = value; setDraft(value); }, []);
  const edit = (value: Partial<Draft>) => updateDraft({ ...draftRef.current, ...value });
  const accept = useCallback((message: Message) => {
    if (message.projectId !== latest.current.projectId) throw new Error("对话回执不属于当前项目。");
    const current = [...messagesRef.current.filter(value => value.messageId !== message.messageId), message].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-200);
    messagesRef.current = current; setMessages(current);
    if (message.generation) latest.current.onGeneration(message.generation);
  }, []);
  const read = useCallback(async () => {
    const context = api.current; if (!context || pollBusy.current) return;
    pollBusy.current = true;
    try {
      const page = await context.list(); if (!mounted.current || api.current !== context) return;
      for (const message of page.messages) accept(message);
      setNextCursor(page.nextCursor); setError("");
      if (!readyRef.current) { revision.current = page.draft?.revision ?? 0; const restored = page.draft ? draftValue(page.draft) : empty(); confirmedDraft.current = restored; updateDraft(restored); readyRef.current = true; setReady(true); }
    } catch (failure) { if (mounted.current && api.current === context) setError(explain(failure)); }
    finally { if (api.current === context) pollBusy.current = false; }
  }, [accept, updateDraft]);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const context = api.current;
    if (!readyRef.current || !context) throw new Error("对话草稿还未恢复，请重新读取后再离开。");
    if (composing.current) throw new Error("请先完成当前中文输入，再保存对话。");
    if (same(draftRef.current, confirmedDraft.current!)) return;
    if (latest.current.readOnly) throw new Error("项目当前只读，对话草稿尚未保存。");
    if (saveBusy.current) throw new Error("对话正在保存，请稍后再确认。");
    saveBusy.current = true; setSaving(true);
    const operation = saveSnapshot.current ?? { ...structuredClone(draftRef.current), revision: revision.current }; saveSnapshot.current = operation;
    try {
      let receipt;
      try { receipt = await context.saveDraft(operation); }
      catch (failure) {
        if (!(failure instanceof NovartApiError) || !failure.uncertain && failure.status !== 409) throw failure;
        const state = await context.list();
        if (!state.draft || state.draft.revision !== operation.revision + 1 || !same(draftValue(state.draft), draftValue(operation))) throw new Error("另一份对话草稿已更新，当前输入仍保留；请先核对服务器状态。");
        receipt = state.draft;
      }
      if (!mounted.current || api.current !== context) return;
      revision.current = receipt.revision; confirmedDraft.current = draftValue(receipt); saveSnapshot.current = null; setError("");
      // A recovered write can describe an older snapshot. Do not approve leave
      // or send until the CURRENT composer has also received a checked receipt.
      for (let attempt = 0; !same(draftRef.current, confirmedDraft.current) && attempt < 3; attempt++) {
        const newer = { ...structuredClone(draftRef.current), revision: revision.current }; saveSnapshot.current = newer;
        const saved = await context.saveDraft(newer);
        if (!mounted.current || api.current !== context) return;
        revision.current = saved.revision; confirmedDraft.current = draftValue(saved); saveSnapshot.current = null;
      }
      if (!same(draftRef.current, confirmedDraft.current)) throw new Error("对话仍有新的输入，请停下输入后再确认保存。");
    } catch (failure) { if (mounted.current && api.current === context) setError(explain(failure)); throw failure; }
    finally { if (api.current === context) { saveBusy.current = false; setSaving(false); } }
  }, []);
  const send = useCallback(async () => {
    const context = api.current;
    if (!context || !readyRef.current || latest.current.readOnly || composing.current || sendBusy.current) return;
    sendBusy.current = true; setSending(true);
    try {
      let operation = pending.current;
      if (!operation) {
        await flush(); const prepared = await latest.current.prepare();
        if (!mounted.current || api.current !== context) return;
        operation = StudioConversationInput.parse({ ...structuredClone(draftRef.current), ...prepared, mutationId: crypto.randomUUID() });
        // Persist before sending. A storage error must not lead to an untracked paid request.
        localStorage.setItem(keyRef.current, JSON.stringify(operation)); pending.current = operation; setUnknown(true);
      }
      const message = StudioConversationMessage.parse(await context.send(operation));
      if (!mounted.current || api.current !== context) return;
      if (message.mutationId !== operation.mutationId || message.text !== operation.text) throw new Error("对话受理回执与原请求不一致，原请求仍保留。");
      accept(message); localStorage.removeItem(keyRef.current); pending.current = null; setUnknown(false); setPaused(false); setError("");
      updateDraft({ ...draftRef.current, text: "" });
    } catch (failure) {
      if (mounted.current && api.current === context) {
        if (failure instanceof NovartApiError && !failure.uncertain && failure.status !== null && failure.status >= 400 && failure.status < 500) {
          localStorage.removeItem(keyRef.current); pending.current = null; setUnknown(false);
        }
        setError(explain(failure));
      }
      throw failure;
    }
    finally { if (api.current === context) { sendBusy.current = false; setSending(false); } }
  }, [accept, flush, updateDraft]);
  useImperativeHandle(ref, () => ({ flush, confirmed: () => readyRef.current && !composing.current && !saveBusy.current && !saveSnapshot.current && same(draftRef.current, confirmedDraft.current!),
    addReferences(refs, quickEditTargetId) { if (!readyRef.current || latest.current.readOnly || sendBusy.current || pending.current) throw new Error("对话尚未准备完成，请确认草稿和上一份受理回执。");
      const base = quickEditTargetId ? draftRef.current.references.filter(value => !refs.some(ref => ref.assetId === value.assetId)) : draftRef.current.references;
      const merged = mergeOwnedConversationReferences(base, refs);
      const target = quickEditTargetId ? merged.find(value => value.referenceId === quickEditTargetId) : undefined;
      if (quickEditTargetId && !target) throw new Error("快捷编辑目标不在当前引用中。");
      updateDraft({ ...draftRef.current, references: merged, ...(target ? { quickEditTargetId: target.referenceId } : {}) });
      requestAnimationFrame(() => input.current?.focus()); },
    async quickEdit(reference, text) { if (!readyRef.current || pending.current || latest.current.readOnly) throw new Error("请先确认对话已恢复和上一份请求。");
      updateDraft({ ...draftRef.current, references: mergeOwnedConversationReferences(draftRef.current.references.filter(value => value.assetId !== reference.assetId), [reference]), quickEditTargetId: reference.referenceId, text }); await send(); },
  }), [flush, updateDraft, send]);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); const context = createOwnedConversationApi(props.workspaceId, props.projectId, props.userId, controller.signal); api.current = context;
    readyRef.current = false; setReady(false); confirmedDraft.current = null; revision.current = 0; pending.current = null; saveSnapshot.current = null; messagesRef.current = []; setMessages([]); setUnknown(false); setError("");
    saveBusy.current = false; sendBusy.current = false; pollBusy.current = false; composing.current = false; setSaving(false); setSending(false); setPaused(false);
    try { const stored = localStorage.getItem(journalKey); if (stored) { pending.current = StudioConversationInput.parse(JSON.parse(stored)); setUnknown(true); } }
    catch { setError("上一份请求记录暂不可读，请先查看服务器任务；不会自动再次发送。"); setUnknown(true); }
    void read();
    return () => { mounted.current = false; controller.abort(); if (timer.current) clearTimeout(timer.current); api.current = null; };
  }, [props.workspaceId, props.projectId, props.userId, journalKey, read]);
  useEffect(() => { if (!ready || props.readOnly || error || composing.current || same(draft, confirmedDraft.current!)) return; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 700); return () => { if (timer.current) clearTimeout(timer.current); }; }, [draft, ready, props.readOnly, error, flush, saving]);
  useEffect(() => {
    if (!ready || paused || !messages.some(active)) return;
    const expired = messages.filter(active).every(value => Date.now() > Date.parse(value.expiresAt));
    if (expired) { setPaused(true); return; }
    const interval = setTimeout(() => { void (async () => { const context = api.current; if (!context) return; try { for (const message of messagesRef.current.filter(active).slice(-8)) { const receipt = await context.read(message.messageId); if (mounted.current && api.current === context) accept(receipt); } } catch (failure) { if (mounted.current) setError(explain(failure)); } })(); }, 3500);
    return () => clearTimeout(interval);
  }, [messages, ready, paused, accept]);
  useEffect(() => { if (follow.current) history.current?.scrollTo({ top: history.current.scrollHeight, behavior: "auto" }); }, [messages]);
  useEffect(() => { const leaving = (event: BeforeUnloadEvent) => { if (readyRef.current && !same(draftRef.current, confirmedDraft.current!) || pending.current) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", leaving); return () => window.removeEventListener("beforeunload", leaving); }, []);
  const locked = props.readOnly || !ready || sending || unknown;
  return <section className="flex min-h-[400px] flex-col gap-3" data-testid="owned-conversation" data-conversation-ready={ready}>
    <div className="flex items-center gap-2"><h2 className="mr-auto text-sm font-semibold">设计对话</h2><button className={button} disabled={sending || saving} onClick={() => { setPaused(false); void read(); }}>读取最新</button></div>
    <div ref={history} className="max-h-[48dvh] min-h-32 space-y-4 overflow-y-auto" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }} aria-label="项目对话记录">
      {nextCursor && <button className={button + " w-full"} onClick={() => { const context = api.current; if (context) void context.list(nextCursor).then(page => { if (api.current !== context) return; page.messages.forEach(accept); setNextCursor(page.nextCursor); }).catch(failure => setError(explain(failure))); }}>读取更早对话</button>}
      {!messages.length && <p className="py-6 text-center text-xs leading-6 text-muted-fg">描述想法开始创作。<br />选中图片后，点击「加入对话」再发送修改或参考需求。</p>}
      {messages.map(message => <article key={message.messageId} className="space-y-2" data-message-id={message.messageId}>
        <div className="ml-5 rounded-2xl rounded-tr-md bg-accent-soft p-3 text-sm leading-6"><p className="whitespace-pre-wrap break-words">{message.text}</p>{message.references.length > 0 && <p className="mt-2 text-xs text-muted-fg">{message.references.map(value => value.name).join("、")}</p>}</div>
        {message.clarification && <p className="rounded-xl border border-border p-3 text-xs leading-6">{message.clarification}</p>}
        {message.intent?.modelStatus === "UNAVAILABLE" && <p className="p-2 text-xs leading-6 text-muted-fg">智能意图识别暂不可用，已按明确指令判断需求。</p>}
        {message.intent?.modelStatus === "UNKNOWN" && <p className="p-2 text-xs leading-6 text-muted-fg">智能意图识别结果尚未确认，请补充明确目标；不会重复调用。</p>}
        {message.error && <p role="alert" className="p-2 text-xs leading-6">{message.error}</p>}
        {active(message) && <p className="p-2 text-xs text-muted-fg">{Date.now() > Date.parse(message.expiresAt) ? "等待较久，请读取任务确认；不会重复调用模型。" : message.generation ? message.generation.progress === null ? '正在创作…' : `正在创作 · ${message.generation.progress}%` : "需求已受理，正在核对图片和尺寸…"}</p>}
        {message.generation && <OwnedGenerationCard task={message.generation} api={props.api} canEdit={!props.readOnly} onTask={task => accept({ ...message, generation: task })} onNotice={props.onNotice} onInsert={image => props.onInsert(image, message.intent?.action === "modify" ? message.references.find(ref => ref.referenceId === message.intent?.targetReferenceId)?.shapeId : undefined)} onInsertLayers={props.onInsertLayers} />}
      </article>)}
    </div>
    {error && <div role="alert" className="rounded-xl bg-accent-soft p-3 text-xs leading-6">{error}{ready && !unknown && <button className="ml-2 underline" onClick={() => { setError(""); void flush().catch(() => undefined); }}>确认草稿</button>}</div>}
    {unknown && <div className="space-y-2 rounded-xl border border-border p-3"><p className="text-xs leading-6">上一份请求尚未确认，需求和引用已冻结。确认会读取／重放同一受理号，避免重复付费。</p><button className={button} disabled={sending || !pending.current || props.readOnly} onClick={() => void send().catch(() => undefined)}>确认原请求回执</button></div>}
    <div className="mt-auto space-y-3 rounded-3xl border border-border bg-bg p-3">
      {draft.quickEditTargetId && <button className={button} disabled={locked} onClick={() => edit({ quickEditTargetId: null })}>取消固定编辑目标</button>}
      <div className="flex flex-wrap gap-2" aria-label="对话引用图片">{draft.references.map((value, index) => <span key={value.referenceId} className="inline-flex max-w-full items-center gap-2 rounded-full bg-accent-soft px-3 py-2 text-xs"><span className="max-w-40 truncate">{index + 1}. {value.name}{draft.quickEditTargetId === value.referenceId ? " · 编辑目标" : ""}</span><button aria-label={`移除对话引用 ${value.name}`} disabled={locked} onClick={() => edit({ references: draft.references.filter(ref => ref.referenceId !== value.referenceId), ...(draft.quickEditTargetId === value.referenceId ? { quickEditTargetId: null } : {}) })}>×</button></span>)}</div>
      <textarea ref={input} aria-label="对话设计需求" className="min-h-24 w-full resize-y bg-transparent text-sm leading-6 outline-none" placeholder={draft.quickEditTargetId ? "描述这张图片要怎么修改" : "输入想法，或添加图片作为参考"} value={draft.text} maxLength={4000} disabled={locked} onChange={event => edit({ text: event.target.value })} onCompositionStart={() => { composing.current = true; if (timer.current) clearTimeout(timer.current); }} onCompositionEnd={() => { composing.current = false; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(() => undefined), 700); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); if (draftRef.current.text.trim()) void send().catch(() => undefined); } }} />
      <div className="flex flex-wrap items-center gap-2"><select aria-label="对话图片比例" className={button} value={draft.sizeSelection.ratioKey} disabled={locked} onChange={event => edit({ sizeSelection: { ...draft.sizeSelection, ratioKey: event.target.value as Draft["sizeSelection"]["ratioKey"] } })}>{["1:1", "3:4", "4:3", "9:16", "16:9"].map(value => <option key={value}>{value}</option>)}</select><select aria-label="对话图片画质" className={button} value={draft.sizeSelection.resolutionTier} disabled={locked} onChange={event => edit({ sizeSelection: { ...draft.sizeSelection, resolutionTier: event.target.value as "1K" | "2K" } })}><option>1K</option><option>2K</option></select><button className="ml-auto rounded-full bg-primary px-4 py-2 text-sm text-primary-fg disabled:opacity-40" disabled={locked || !draft.text.trim()} onClick={() => void send().catch(() => undefined)}>{sending ? "确认受理…" : "发送"}</button></div>
      <p className="text-xs leading-5 text-muted-fg">{saving ? "正在保存对话草稿…" : !ready ? "正在恢复项目对话…" : same(draft, confirmedDraft.current!) ? "对话草稿已保存" : "对话草稿待保存"} · 对话中明确的图片尺寸优先。Enter 发送，Shift+Enter 换行。</p>
    </div>
  </section>;
});
