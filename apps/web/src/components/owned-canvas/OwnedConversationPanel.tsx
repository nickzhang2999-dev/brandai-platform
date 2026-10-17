"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StudioConversationInput, StudioConversationMessage, type StudioConversationDraftInput, type StudioConversationReference, type StudioConversationMessage as Message } from "@brandai/contracts";
import type { z } from "zod";
import { NovartApiError } from "../../lib/novart-api-client";
import { createOwnedConversationApi } from "./owned-conversation-api";
import { mergeOwnedConversationReferences, ownedConversationDraftEqual } from "./owned-conversation-references";
import { ownedConversationActive as active, ownedConversationDeadline as deadline, ownedConversationGeneration } from "./owned-conversation-state";
import { OwnedGenerationCard } from "./OwnedGenerationCard";
import type { createOwnedEditorApi, DecompositionTask, GenerationTask, PersistentImage } from "./owned-editor-api";

type Draft = Omit<StudioConversationDraftInput, "revision">;
type Input = z.infer<typeof StudioConversationInput>;
export type OwnedConversationHandle = { flush(): Promise<void>; confirmed(): boolean; addReferences(refs: StudioConversationReference[], quickEditTargetId?: string): void; quickEdit(ref: StudioConversationReference, text: string): Promise<void> };
type Props = { workspaceId: string; projectId: string; userId: string; readOnly: boolean;
  api: ReturnType<typeof createOwnedEditorApi> | null;
  prepare(): Promise<{ documentRevision: number; workflowRevision: number; outputFrameId?: string }>;
  onNotice(message: string): void; onGeneration(task: GenerationTask): void; onInsert(image: PersistentImage, sourceShapeId?: string): Promise<void>;
  onInsertLayers(task: DecompositionTask, source: PersistentImage): Promise<void>; onAddReference?(): void };
const button = "rounded-full border border-border px-3 py-2 text-xs disabled:opacity-40";
const empty = (): Draft => ({ text: "", references: [], quickEditTargetId: null, sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } });
const draftValue = (value: StudioConversationDraftInput): Draft => ({ text: value.text, references: value.references, quickEditTargetId: value.quickEditTargetId, sizeSelection: value.sizeSelection });
const same = ownedConversationDraftEqual;
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
  const requestOrder = useRef(0), acceptedOrder = useRef(new Map<string, number>()), cursorOrder = useRef(0);
  const updateDraft = useCallback((value: Draft) => { draftRef.current = value; setDraft(value); }, []);
  const edit = (value: Partial<Draft>) => updateDraft({ ...draftRef.current, ...value });
  const accept = useCallback((message: Message, order = ++requestOrder.current) => {
    if (message.projectId !== latest.current.projectId) throw new Error("对话结果不属于当前项目。");
    // A poll/list started before a newer read or explicit retry cannot undo it.
    // Do not freeze READY forever: a later authoritative read can revoke assets.
    if (order < (acceptedOrder.current.get(message.messageId) ?? 0)) return;
    acceptedOrder.current.set(message.messageId, order);
    const current = [...messagesRef.current.filter(value => value.messageId !== message.messageId), message].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-200);
    messagesRef.current = current; setMessages(current);
    if (message.generation) latest.current.onGeneration(message.generation);
  }, []);
  const acceptGeneration = useCallback((messageId: string, generation: GenerationTask) => {
    const current = messagesRef.current.find(message => message.messageId === messageId);
    if (!current) return;
    const updated = ownedConversationGeneration(current, generation);
    if (updated !== current) accept(updated);
  }, [accept]);
  const read = useCallback(async () => {
    const context = api.current; if (!context || pollBusy.current) return;
    pollBusy.current = true; const order = ++requestOrder.current;
    try {
      const page = await context.list(); if (!mounted.current || api.current !== context) return;
      for (const message of page.messages) accept(message, order);
      if (order >= cursorOrder.current) { cursorOrder.current = order; setNextCursor(page.nextCursor); }
      setError("");
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
        await flush();
        if (!mounted.current || api.current !== context) return;
        const prepared = await latest.current.prepare();
        if (!mounted.current || api.current !== context) return;
        operation = StudioConversationInput.parse({ ...structuredClone(draftRef.current), ...prepared, mutationId: crypto.randomUUID() });
        // Persist before sending. A storage error must not lead to an untracked paid request.
        localStorage.setItem(keyRef.current, JSON.stringify(operation)); pending.current = operation; setUnknown(true);
      }
      const order = ++requestOrder.current;
      const message = StudioConversationMessage.parse(await context.send(operation));
      if (!mounted.current || api.current !== context) return;
      if (message.mutationId !== operation.mutationId || message.text !== operation.text) throw new Error("对话提交结果与原请求不一致，原请求仍保留。");
      accept(message, order); localStorage.removeItem(keyRef.current); pending.current = null; setUnknown(false); setPaused(false); setError("");
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
    addReferences(refs, quickEditTargetId) { if (!readyRef.current || latest.current.readOnly || sendBusy.current || pending.current) throw new Error("对话还没准备好，请稍候，或先检查上次提交。");
      const base = quickEditTargetId ? draftRef.current.references.filter(value => !refs.some(ref => ref.assetId === value.assetId)) : draftRef.current.references;
      const merged = mergeOwnedConversationReferences(base, refs);
      const target = quickEditTargetId ? merged.find(value => value.referenceId === quickEditTargetId) : undefined;
      if (quickEditTargetId && !target) throw new Error("快捷编辑目标不在当前引用中。");
      updateDraft({ ...draftRef.current, references: merged, ...(target ? { quickEditTargetId: target.referenceId } : {}) });
      requestAnimationFrame(() => input.current?.focus()); },
    async quickEdit(reference, text) { if (!readyRef.current || pending.current || sendBusy.current || latest.current.readOnly) throw new Error("请先确认对话已恢复和上一份请求。");
      updateDraft({ ...draftRef.current, references: mergeOwnedConversationReferences(draftRef.current.references.filter(value => value.assetId !== reference.assetId), [reference]), quickEditTargetId: reference.referenceId, text }); await send(); },
  }), [flush, updateDraft, send]);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); const context = createOwnedConversationApi(props.workspaceId, props.projectId, props.userId, controller.signal); api.current = context;
    readyRef.current = false; setReady(false); confirmedDraft.current = null; revision.current = 0; pending.current = null; saveSnapshot.current = null; messagesRef.current = []; setMessages([]); setUnknown(false); setError("");
    updateDraft(empty()); setNextCursor(null); acceptedOrder.current.clear(); requestOrder.current = 0; cursorOrder.current = 0;
    saveBusy.current = false; sendBusy.current = false; pollBusy.current = false; composing.current = false; setSaving(false); setSending(false); setPaused(false);
    try { const stored = localStorage.getItem(journalKey); if (stored) { pending.current = StudioConversationInput.parse(JSON.parse(stored)); setUnknown(true); } }
    catch { setError("上一份请求记录暂不可读，请先查看服务器任务；不会自动再次发送。"); setUnknown(true); }
    void read();
    return () => { mounted.current = false; controller.abort(); if (timer.current) clearTimeout(timer.current); api.current = null; };
  }, [props.workspaceId, props.projectId, props.userId, journalKey, read, updateDraft]);
  useEffect(() => { if (!ready || props.readOnly || error || composing.current || same(draft, confirmedDraft.current!)) return; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 700); return () => { if (timer.current) clearTimeout(timer.current); }; }, [draft, ready, props.readOnly, error, flush, saving]);
  useEffect(() => {
    if (!ready || !messages.some(active)) return;
    const pending = messages.filter(value => active(value) && Date.now() < deadline(value));
    if (!pending.length) { if (!paused) setPaused(true); return; }
    if (paused) setPaused(false);
    const delay = Math.min(3500, Math.max(1, Math.min(...pending.map(deadline)) - Date.now() + 1));
    const interval = setTimeout(() => { void (async () => {
      const context = api.current; if (!context) return;
      if (messagesRef.current.some(active) && !messagesRef.current.some(value => active(value) && Date.now() < deadline(value))) { setPaused(true); return; }
      try {
        for (const message of messagesRef.current.filter(value => active(value) && Date.now() < deadline(value)).slice(-8)) {
          if (!mounted.current || api.current !== context) return;
          const order = ++requestOrder.current, receipt = await context.read(message.messageId);
          if (mounted.current && api.current === context) accept(receipt, order);
        }
      } catch (failure) { if (mounted.current && api.current === context) setError(explain(failure)); }
    })(); }, delay);
    return () => clearTimeout(interval);
  }, [messages, ready, paused, accept]);
  useEffect(() => { if (follow.current) history.current?.scrollTo({ top: history.current.scrollHeight, behavior: "auto" }); }, [messages]);
  useEffect(() => { const leaving = (event: BeforeUnloadEvent) => { if (readyRef.current && !same(draftRef.current, confirmedDraft.current!) || pending.current) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", leaving); return () => window.removeEventListener("beforeunload", leaving); }, []);
  const locked = props.readOnly || !ready || sending || unknown;
  function reedit(message: Message) {
    // Recover a draft only. Never reuse an accepted mutation or call send().
    if (props.readOnly || !readyRef.current || sendBusy.current || pending.current || composing.current) return;
    if (draftRef.current.text.trim() || draftRef.current.references.length > 0 && JSON.stringify(draftRef.current.references) !== JSON.stringify(message.references)) { props.onNotice("输入框中还有未发送的需求或不同引用，请先保留或清空，再重新编辑这条需求。"); input.current?.focus(); return; }
    const target = message.intent?.action === "modify" ? message.references.find(value => value.shapeId && value.referenceId === message.intent?.targetReferenceId) : undefined;
    updateDraft({ text: message.text, references: message.references, quickEditTargetId: target?.referenceId ?? null, sizeSelection: message.intent?.sizeSelection ?? draftRef.current.sizeSelection });
    props.onNotice("需求已放回输入框，请确认图片和内容后点击发送。"); input.current?.focus();
  }
  return <section className="flex h-full min-h-0 flex-col gap-3" data-testid="owned-conversation" data-conversation-ready={ready}>
    <div className="flex shrink-0 justify-end"><button className="rounded-full px-2 py-1 text-xs text-muted-foreground disabled:opacity-40" disabled={sending || saving} onClick={() => { setPaused(false); void read(); }}>读取最新</button></div>
    <div ref={history} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }} aria-label="项目对话记录">
      {nextCursor && <button className={button + " w-full"} onClick={() => { const context = api.current, order = ++requestOrder.current; if (context) void context.list(nextCursor).then(page => { if (!mounted.current || api.current !== context) return; page.messages.forEach(message => accept(message, order)); if (order >= cursorOrder.current) { cursorOrder.current = order; setNextCursor(page.nextCursor); } }).catch(failure => { if (mounted.current && api.current === context) setError(explain(failure)); }); }}>读取更早对话</button>}
      {!messages.length && <p className="py-6 text-center text-xs leading-6 text-muted-foreground">描述想法开始创作。<br />选中图片后，点击「加入对话」再发送修改或参考需求。</p>}
      {messages.map(message => <article key={message.messageId} className="space-y-2" data-message-id={message.messageId}>
        <div className="ml-5 rounded-2xl rounded-tr-md bg-accent-soft p-3 text-sm leading-6"><p className="whitespace-pre-wrap break-words">{message.text}</p>{message.references.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{message.references.map(value => value.name).join("、")}</p>}</div>
        {message.clarification && <p className="rounded-xl border border-border p-3 text-xs leading-6">{message.clarification}</p>}
        {message.intent?.modelStatus === "UNAVAILABLE" && !message.generation && <p className="p-2 text-xs leading-6 text-muted-foreground">智能意图识别暂不可用，已按明确指令判断需求。</p>}
        {message.intent?.modelStatus === "UNKNOWN" && <p className="p-2 text-xs leading-6 text-muted-foreground">智能意图识别结果尚未确认，请补充明确目标；不会重复调用。</p>}
        {message.error && !message.generation && <p role="alert" className="p-2 text-xs leading-6">{message.error}</p>}
        {active(message) && !message.generation && <p className="p-2 text-xs text-muted-foreground">{Date.now() >= deadline(message) ? "等待较久，请读取任务确认；不会重复调用模型。" : "需求已提交，正在核对图片和尺寸…"}</p>}
        {message.generation && <OwnedGenerationCard compact activityNotice={active(message) && Date.now() >= deadline(message) ? "等待较久，请读取任务确认；不会重复调用模型。" : undefined} task={message.generation} api={props.api} canEdit={!props.readOnly} recoveryDisabled={locked} onReedit={() => reedit(message)} onTask={task => acceptGeneration(message.messageId, task)} onNotice={props.onNotice} onInsert={image => props.onInsert(image, message.intent?.action === "modify" ? message.references.find(ref => ref.referenceId === message.intent?.targetReferenceId)?.shapeId : undefined)} onInsertLayers={props.onInsertLayers} />}
      </article>)}
    </div>
    {error && <div role="alert" className="rounded-xl bg-accent-soft p-3 text-xs leading-6">{error}{ready && !unknown && <button className="ml-2 underline" onClick={() => { setError(""); void flush().catch(() => undefined); }}>确认草稿</button>}</div>}
    {unknown && <div className="space-y-2 rounded-xl border border-border p-3"><p className="text-xs leading-6">上次提交的结果还没确认，需求和引用先保留不动。点“检查上次提交”会读取同一次请求，不会重复扣费。</p><button className={button} disabled={sending || !pending.current || props.readOnly} onClick={() => void send().catch(() => undefined)}>检查上次提交</button></div>}
    <div className="mt-auto shrink-0 space-y-3 rounded-3xl border border-border bg-background p-3">
      <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto" aria-label="对话引用图片">{draft.references.map(value => {
        const target = draft.quickEditTargetId === value.referenceId;
        return <span key={value.referenceId} className={"inline-flex max-w-full items-center gap-1 rounded-2xl border p-1 " + (target ? "border-primary bg-accent-soft" : "border-border bg-card")}>
          <button type="button" aria-label={`修改对象 ${value.name}`} aria-pressed={target} title={value.shapeId ? target ? "点击取消修改目标" : "点击设为修改目标" : "素材仅用作参考"} disabled={locked || !value.shapeId} className="flex min-w-0 items-center gap-2 rounded-xl text-left disabled:cursor-default" onClick={() => edit({ quickEditTargetId: target ? null : value.referenceId })}>
            <img src={`/api/workspaces/${encodeURIComponent(props.workspaceId)}/assets/${encodeURIComponent(value.assetId)}/raw`} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" loading="lazy" />
            <span className="min-w-0"><span className="block max-w-28 truncate text-xs">{value.name}</span><span className={"block text-xs " + (target ? "text-primary" : "text-muted-foreground")}>{target ? "正在修改" : "参考"}</span></span>
          </button>
          <button type="button" aria-label={`移除对话引用 ${value.name}`} className="rounded-full px-2 py-1 text-muted-foreground" disabled={locked} onClick={() => edit({ references: draft.references.filter(ref => ref.referenceId !== value.referenceId), ...(target ? { quickEditTargetId: null } : {}) })}>×</button>
        </span>;
      })}</div>
      <textarea ref={input} aria-label="对话设计需求" className="h-24 max-h-40 min-h-16 w-full resize-none bg-transparent text-sm leading-6 outline-none" placeholder={draft.quickEditTargetId ? "描述这张图片要怎么修改" : "输入想法，或添加图片作为参考"} value={draft.text} maxLength={4000} disabled={locked} onChange={event => edit({ text: event.target.value })} onCompositionStart={() => { composing.current = true; if (timer.current) clearTimeout(timer.current); }} onCompositionEnd={() => { composing.current = false; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(() => undefined), 700); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); if (draftRef.current.text.trim()) void send().catch(() => undefined); } }} />
      <div className="flex items-center gap-2">
        {props.onAddReference && <button type="button" className={button} aria-label="添加参考图片" title="从素材库添加参考图片" disabled={locked} onClick={props.onAddReference}>＋</button>}
        <details className="relative" data-testid="conversation-settings"><summary className={button + " cursor-pointer list-none"} aria-label="生成设置">设置</summary>
          <div className="absolute bottom-full left-0 z-30 mb-2 w-60 space-y-3 rounded-2xl border border-border bg-card p-4 shadow-lg">
            <label className="flex items-center justify-between text-xs">比例<select aria-label="对话图片比例" className={button} value={draft.sizeSelection.ratioKey} disabled={locked} onChange={event => edit({ sizeSelection: { ...draft.sizeSelection, ratioKey: event.target.value as Draft["sizeSelection"]["ratioKey"] } })}>{["1:1", "3:4", "4:3", "9:16", "16:9"].map(value => <option key={value}>{value}</option>)}</select></label>
            <label className="flex items-center justify-between text-xs">画质<select aria-label="对话图片画质" className={button} value={draft.sizeSelection.resolutionTier} disabled={locked} onChange={event => edit({ sizeSelection: { ...draft.sizeSelection, resolutionTier: event.target.value as "1K" | "2K" } })}><option>1K</option><option>2K</option></select></label>
            <p className="text-xs leading-5 text-muted-foreground">需求里指定的尺寸优先。Enter 发送，Shift+Enter 换行。</p>
          </div>
        </details>
        <span role="status" className="min-w-0 truncate text-xs text-muted-foreground" title={saving ? "正在保存对话草稿…" : !ready ? "正在恢复项目对话…" : same(draft, confirmedDraft.current!) ? "对话草稿已保存" : "对话草稿待保存"} data-testid="conversation-draft-status" data-saved={ready && !saving && same(draft, confirmedDraft.current!)}>{saving ? "保存中…" : !ready ? "恢复中…" : same(draft, confirmedDraft.current!) ? "已保存" : "待保存"}</span>
        <button className="ml-auto rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40" disabled={locked || !draft.text.trim()} onClick={() => void send().catch(() => undefined)}>{sending ? "正在提交…" : "发送"}</button>
      </div>
    </div>
  </section>;
});
