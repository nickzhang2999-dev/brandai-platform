"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { GenerationAspectRatioKey, StudioConversationInput, StudioConversationMessage, type StudioConversationDraftInput, type StudioConversationReference, type StudioConversationMessage as Message } from "@brandai/contracts";
import type { z } from "zod";
import { NovartApiError } from "../../lib/novart-api-client";
import { createOwnedConversationApi } from "./owned-conversation-api";
import { chooseOwnedConversationTarget, mergeOwnedConversationReferences, ownedConversationDraftEqual, ownedConversationSizePreview, requireOwnedConversationTargetEditable } from "./owned-conversation-references";
import { ownedConversationActive as active, ownedConversationDeadline as deadline, ownedConversationGeneration } from "./owned-conversation-state";
import { ownedConversationChoices, ownedConversationDecisionInput, ownedConversationAcknowledges, type ConversationDecisionKind } from "./owned-conversation-decisions";
import { OwnedGenerationCard } from "./OwnedGenerationCard";
import type { createOwnedEditorApi, DecompositionTask, GenerationTask, PersistentImage } from "./owned-editor-api";

type Draft = Omit<StudioConversationDraftInput, "revision">;
type Input = z.infer<typeof StudioConversationInput>;
export type OwnedConversationHandle = { ready(): boolean; flush(): Promise<void>; confirmed(): boolean; chooseCanvasTarget(reference: StudioConversationReference | null): void; addReferences(refs: StudioConversationReference[], quickEditTargetId?: string): void; configureReferences(refs: StudioConversationReference[], managedHashes: string[], targetId?: string): void; restoreText(text: string): void; sizeSelection(): Draft["sizeSelection"]; quickEdit(ref: StudioConversationReference, text: string): Promise<void>; startHome(text: string, mutationId: string, refs: StudioConversationReference[]): Promise<void> };
type Props = { workspaceId: string; projectId: string; userId: string; readOnly: boolean;
  api: ReturnType<typeof createOwnedEditorApi> | null;
  prepare(): Promise<{ documentRevision: number; workflowRevision: number; outputFrameId?: string }>;
  selectedReferenceIds?(references: StudioConversationReference[]): string[];
  isImagePlaced?(image: PersistentImage): boolean; onNotice(message: string): void; onGeneration(task: GenerationTask): void; onInsert(image: PersistentImage, sourceShapeId?: string): Promise<void>;
  onInsertLayers(task: DecompositionTask, source: PersistentImage): Promise<void>; onAddReference?(): void; onAdvancedSettings?(): void; outputFrameId?: string; activity?: ReactNode };
const button = "rounded-full border border-border px-3 py-2 text-xs disabled:opacity-40";
const empty = (): Draft => ({ text: "", references: [], quickEditTargetId: null, sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } });
const draftValue = (value: StudioConversationDraftInput): Draft => ({ text: value.text, references: value.references, quickEditTargetId: value.quickEditTargetId, sizeSelection: value.sizeSelection, ...(value.psdLayerMode ? { psdLayerMode: value.psdLayerMode, ...(value.psdLayerCount ? { psdLayerCount: value.psdLayerCount } : {}) } : {}) });
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
  const ownedTargetId = useRef<string | null>(null);
  const updateDraft = useCallback((value: Draft) => { draftRef.current = value; setDraft(value); }, []);
  const edit = (value: Partial<Draft>) => updateDraft({ ...draftRef.current, ...value });
  const chooseCanvasTarget = useCallback((reference: StudioConversationReference | null) => {
    requireOwnedConversationTargetEditable({ ready: readyRef.current, readOnly: latest.current.readOnly, submitting: sendBusy.current, uncertain: !!pending.current || unknown });
    const next = chooseOwnedConversationTarget(draftRef.current, reference, ownedTargetId.current);
    ownedTargetId.current = next.ownedTargetId;
    const value = { ...draftRef.current, references: next.references, quickEditTargetId: next.quickEditTargetId };
    if (!same(value, draftRef.current)) updateDraft(value);
  }, [unknown, updateDraft]);
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
  const flush = useCallback(async (keepalive = false) => {
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
      try { receipt = await context.saveDraft(operation, keepalive); }
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
        const saved = await context.saveDraft(newer, keepalive);
        if (!mounted.current || api.current !== context) return;
        revision.current = saved.revision; confirmedDraft.current = draftValue(saved); saveSnapshot.current = null;
      }
      if (!same(draftRef.current, confirmedDraft.current)) throw new Error("对话仍有新的输入，请停下输入后再确认保存。");
    } catch (failure) { if (mounted.current && api.current === context) setError(explain(failure)); throw failure; }
    finally { if (api.current === context) { saveBusy.current = false; setSaving(false); } }
  }, []);
  const send = useCallback(async (home?: { mutationId: string }, decision?: { messageId: string; optionId: string; kind: ConversationDecisionKind }) => {
    const context = api.current;
    if (!context || !readyRef.current || latest.current.readOnly || composing.current || sendBusy.current) return;
    sendBusy.current = true; setSending(true);
    try {
      if (decision && pending.current) throw new Error("请先检查上次提交，再选择这条需求的处理方式。");
      let operation = pending.current;
      if (!operation) {
        await flush();
        if (!mounted.current || api.current !== context) return;
        const prepared = await latest.current.prepare();
        if (!mounted.current || api.current !== context) return;
        const source = decision ? messagesRef.current.find(message => message.messageId === decision.messageId) : undefined;
        if (decision && !source) throw new Error("原任务暂不可用，请读取最新对话。");
        const references = source?.originalInput?.references ?? draftRef.current.references;
        const selectedReferenceIds = latest.current.selectedReferenceIds?.(references) ?? [];
        operation = decision && source
          ? ownedConversationDecisionInput(source, decision.optionId, decision.kind, prepared, crypto.randomUUID(), selectedReferenceIds)
          : StudioConversationInput.parse({ ...structuredClone(draftRef.current), ...prepared, selectedReferenceIds, mutationId: home?.mutationId ?? crypto.randomUUID(), ...(home ? { homeStart: true } : {}) });
        // Persist before sending. A storage error must not lead to an untracked paid request.
        localStorage.setItem(keyRef.current, JSON.stringify(operation)); pending.current = operation; setUnknown(true);
      }
      const order = ++requestOrder.current;
      const message = StudioConversationMessage.parse(await context.send(operation));
      if (!mounted.current || api.current !== context) return;
      if (!ownedConversationAcknowledges(operation, message)) throw new Error("对话提交结果与原请求不一致，原请求仍保留。");
      accept(message, order); localStorage.removeItem(keyRef.current); pending.current = null; setUnknown(false); setPaused(false); setError("");
      if (!operation.decision) updateDraft({ ...draftRef.current, text: "" });
      return message;
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
  useImperativeHandle(ref, () => ({ ready: () => readyRef.current, flush, confirmed: () => readyRef.current && !composing.current && !saveBusy.current && !saveSnapshot.current && same(draftRef.current, confirmedDraft.current!), chooseCanvasTarget,
    async startHome(text, mutationId, refs) {
      if (!readyRef.current || latest.current.readOnly || sendBusy.current || composing.current) throw new Error("请先完成当前输入，等待对话恢复后继续创作。");
      const accepted = messagesRef.current.find(message => message.mutationId === mutationId);
      if (accepted) {
        if (accepted.text !== text.trim() || !same(accepted.references, refs)) throw new Error("首页恢复内容与原提交不一致，请核对原任务。");
        if (pending.current?.mutationId === mutationId) { localStorage.removeItem(keyRef.current); pending.current = null; setUnknown(false); setError(""); }
        if (draftRef.current.text.trim() === text.trim()) updateDraft({ ...draftRef.current, text: "" });
        return;
      }
      if (pending.current && pending.current.mutationId !== mutationId) throw new Error("请先确认上一份对话提交。");
      if (!pending.current && draftRef.current.text.trim() && draftRef.current.text !== text) throw new Error("对话里已有另一份未发送需求，请先保留或清空，再继续首页创作。");
      if (!pending.current) { ownedTargetId.current = null; updateDraft({ ...empty(), text, references: refs }); }
      const acceptedMessage = await send({ mutationId });
      if (!acceptedMessage || acceptedMessage.mutationId !== mutationId) throw new Error("首次创作还没确认提交结果，原需求仍保留。");
    },
    sizeSelection: () => structuredClone(draftRef.current.sizeSelection),
    restoreText(text) {
      if (!readyRef.current || latest.current.readOnly || sendBusy.current || pending.current || draftRef.current.text.trim()) throw new Error("请先确认或清空当前输入，原需求仍保留。");
      if (text.length > 4000) throw new Error("旧需求超过 4000 字，请先复制并精简后使用，不会截断原文。");
      updateDraft({ ...draftRef.current, text }); requestAnimationFrame(() => input.current?.focus());
    },
    configureReferences(refs, managedHashes, targetId) {
      if (!readyRef.current || latest.current.readOnly || sendBusy.current || pending.current) throw new Error("请先确认对话已恢复和上一份提交。");
      requireOwnedConversationTargetEditable({ ready: readyRef.current, readOnly: latest.current.readOnly, submitting: sendBusy.current, uncertain: !!pending.current || unknown });
      const merged = mergeOwnedConversationReferences(draftRef.current.references.filter(value => !managedHashes.includes(value.assetSha256)), refs);
      if (targetId && !merged.some(value => value.referenceId === targetId && value.shapeId)) throw new Error("修改目标尚未确认加入对话。");
      ownedTargetId.current = null;
      updateDraft({ ...draftRef.current, references: merged, quickEditTargetId: targetId ?? (merged.some(value => value.referenceId === draftRef.current.quickEditTargetId) ? draftRef.current.quickEditTargetId : null) });
    },
    addReferences(refs, quickEditTargetId) { if (!readyRef.current || latest.current.readOnly || sendBusy.current || pending.current) throw new Error("对话还没准备好，请稍候，或先检查上次提交。");
      requireOwnedConversationTargetEditable({ ready: readyRef.current, readOnly: latest.current.readOnly, submitting: sendBusy.current, uncertain: !!pending.current || unknown });
      const target = quickEditTargetId ? refs.find(value => value.referenceId === quickEditTargetId) : undefined;
      if (quickEditTargetId && !target) throw new Error("快捷编辑目标不在当前引用中。");
      if (target) {
        const next = chooseOwnedConversationTarget(draftRef.current, target, ownedTargetId.current);
        const merged = mergeOwnedConversationReferences(next.references, refs.filter(value => value.assetId !== target.assetId));
        ownedTargetId.current = next.ownedTargetId; updateDraft({ ...draftRef.current, references: merged, quickEditTargetId: next.quickEditTargetId });
      } else {
        const merged = mergeOwnedConversationReferences(draftRef.current.references, refs);
        if (refs.some(value => value.referenceId === ownedTargetId.current || value.assetId === draftRef.current.references.find(current => current.referenceId === ownedTargetId.current)?.assetId)) ownedTargetId.current = null;
        updateDraft({ ...draftRef.current, references: merged });
      }
      requestAnimationFrame(() => input.current?.focus()); },
    async quickEdit(reference, text) { if (!readyRef.current || pending.current || sendBusy.current || latest.current.readOnly) throw new Error("请先确认对话已恢复和上一份请求。");
      chooseCanvasTarget(reference); updateDraft({ ...draftRef.current, text }); await send(); },
  }), [flush, updateDraft, send, chooseCanvasTarget, unknown]);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); const context = createOwnedConversationApi(props.workspaceId, props.projectId, props.userId, controller.signal); api.current = context;
    readyRef.current = false; setReady(false); confirmedDraft.current = null; revision.current = 0; pending.current = null; ownedTargetId.current = null; saveSnapshot.current = null; messagesRef.current = []; setMessages([]); setUnknown(false); setError("");
    updateDraft(empty()); setNextCursor(null); acceptedOrder.current.clear(); requestOrder.current = 0; cursorOrder.current = 0;
    saveBusy.current = false; sendBusy.current = false; pollBusy.current = false; composing.current = false; setSaving(false); setSending(false); setPaused(false);
    try { const stored = localStorage.getItem(journalKey); if (stored) { pending.current = StudioConversationInput.parse(JSON.parse(stored)); setUnknown(true); } }
    catch { setError("上一份请求记录暂不可读，请先查看服务器任务；不会自动再次发送。"); setUnknown(true); }
    void read();
    return () => { mounted.current = false; controller.abort(); if (timer.current) clearTimeout(timer.current); api.current = null; };
  }, [props.workspaceId, props.projectId, props.userId, journalKey, read, updateDraft]);
  useEffect(() => { if (!ready || props.readOnly || error || composing.current || same(draft, confirmedDraft.current!)) return; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 700); return () => { if (timer.current) clearTimeout(timer.current); }; }, [draft, ready, props.readOnly, error, flush, saving]);
  useEffect(() => { const refresh = () => { if (document.visibilityState !== "hidden") void read(); }; window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh); return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); }; }, [read]);
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
  useEffect(() => {
    const saveOnLeave = () => {
      // Do not race an in-flight/uncertain write, commit an IME fragment, or
      // replay a pending paid request. The normal close warning stays active.
      if (readyRef.current && !latest.current.readOnly && !composing.current && !saveBusy.current && !sendBusy.current && !pending.current) void flush(true).catch(() => undefined);
    };
    const leaving = (event: BeforeUnloadEvent) => { if (readyRef.current && !same(draftRef.current, confirmedDraft.current!) || pending.current) { event.preventDefault(); event.returnValue = ""; saveOnLeave(); } };
    const hiding = () => { if (document.visibilityState === "hidden") saveOnLeave(); };
    window.addEventListener("beforeunload", leaving); window.addEventListener("pagehide", saveOnLeave); document.addEventListener("visibilitychange", hiding);
    return () => { window.removeEventListener("beforeunload", leaving); window.removeEventListener("pagehide", saveOnLeave); document.removeEventListener("visibilitychange", hiding); };
  }, [flush]);
  const locked = props.readOnly || !ready || sending || unknown;
  const target = draft.references.find(value => value.referenceId === draft.quickEditTargetId);
  const referenceOnly = draft.references.filter(value => value.referenceId !== draft.quickEditTargetId);
  const sizePreview = ownedConversationSizePreview(draft, props.outputFrameId);
  function clarify(message: Message, targetId?: string) {
    if (locked || message.intent?.modelStatus === "UNKNOWN") return;
    if (draftRef.current.text.trim()) { props.onNotice("输入框还有未发送内容，请先保留或清空，再选择这条需求的处理方式。"); input.current?.focus(); return; }
    ownedTargetId.current = null; updateDraft({ ...draftRef.current, text: targetId ? message.text : `生成一张新图：${message.text}`, references: message.references, quickEditTargetId: targetId ?? null }); input.current?.focus();
  }
  function reedit(message: Message) {
    // Recover a draft only. Never reuse an accepted mutation or call send().
    if (props.readOnly || !readyRef.current || sendBusy.current || pending.current || composing.current) return;
    if (draftRef.current.text.trim() || draftRef.current.references.length > 0 && JSON.stringify(draftRef.current.references) !== JSON.stringify(message.references)) { props.onNotice("输入框中还有未发送的需求或不同引用，请先保留或清空，再重新编辑这条需求。"); input.current?.focus(); return; }
    const target = message.intent?.action === "modify" ? message.references.find(value => value.shapeId && value.referenceId === message.intent?.targetReferenceId) : undefined;
    ownedTargetId.current = null; updateDraft({ text: message.text, references: message.references, quickEditTargetId: target?.referenceId ?? null, sizeSelection: message.intent?.sizeSelection ?? draftRef.current.sizeSelection, ...(message.generation?.psdLayerMode ? { psdLayerMode: message.generation.psdLayerMode, ...(message.generation.psdLayerMode === "MANUAL" && message.generation.psdLayerCount ? { psdLayerCount: message.generation.psdLayerCount } : {}) } : {}) });
    props.onNotice("需求已放回输入框，请确认图片和内容后点击发送。"); input.current?.focus();
  }
  return <section className="flex h-full min-h-0 flex-col gap-3" data-testid="owned-conversation" data-conversation-ready={ready}>
    {(error || paused) && <div className="flex shrink-0 justify-end"><button className="rounded-full px-2 py-1 text-xs text-muted-foreground disabled:opacity-40" disabled={sending || saving} onClick={() => { setPaused(false); void read(); }}>检查任务状态</button></div>}
    <div ref={history} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }} aria-label="项目对话记录">
      {nextCursor && <button className={button + " w-full"} onClick={() => { const context = api.current, order = ++requestOrder.current; if (context) void context.list(nextCursor).then(page => { if (!mounted.current || api.current !== context) return; page.messages.forEach(message => accept(message, order)); if (order >= cursorOrder.current) { cursorOrder.current = order; setNextCursor(page.nextCursor); } }).catch(failure => { if (mounted.current && api.current === context) setError(explain(failure)); }); }}>读取更早对话</button>}
      {!messages.length && <p className="py-6 text-center text-xs leading-6 text-muted-foreground">描述想法开始创作。<br />选中画布图片即可指定修改对象；点击发送才会开始处理。</p>}
      {messages.map(message => <article key={message.messageId} className="space-y-2" data-message-id={message.messageId}>
        <div className="ml-5 rounded-2xl rounded-tr-md bg-accent-soft p-3 text-sm leading-6"><p className="whitespace-pre-wrap break-words">{message.text}</p>{message.references.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{message.references.map(value => value.name).join("、")}</p>}</div>
        {message.clarification && <p className="rounded-xl border border-border p-3 text-xs leading-6">{message.clarification}</p>}
        {ownedConversationChoices(message, "clarification").length > 0 && <div className="space-y-2" data-testid="conversation-clarification-options"><p className="text-xs text-muted-foreground">选择后会开始创作并消耗额度。</p><div className="flex flex-wrap gap-2">{ownedConversationChoices(message, "clarification").map(option => <button key={option.id} type="button" className={button} disabled={locked} onClick={() => void send(undefined, { messageId: message.messageId, optionId: option.id, kind: "clarification" }).catch(() => undefined)}>{option.label}</button>)}</div></div>}
        {message.status === "CLARIFICATION" && message.intent?.modelStatus !== "UNKNOWN" && !message.intent?.options?.length && <div className="flex flex-wrap gap-2"><button className={button} disabled={locked} onClick={() => clarify(message)}>参考生成新图</button>{message.references.filter(value => value.shapeId).map(value => <button key={value.referenceId} className={button} disabled={locked} onClick={() => clarify(message, value.referenceId)}>修改{value.name}</button>)}</div>}
        {message.intent?.modelStatus === "UNKNOWN" && <p className="text-xs leading-6 text-muted-foreground">这次判断结果尚未确认，请检查任务状态；不会再次调用模型。</p>}
        {!!message.intent?.options?.length && !message.originalInput && message.intent.modelStatus !== "UNKNOWN" && <p className="text-xs text-muted-foreground">这条历史需求缺少原始设置，请重新选择图片并确认尺寸后提交。</p>}
        {message.intent?.imagePrompt && <details className="rounded-xl border border-border p-3 text-xs" data-testid="conversation-image-prompt"><summary className="cursor-pointer">实际生成描述</summary><p className="mt-2 text-muted-foreground">生成使用此需求描述，并应用当前品牌和尺寸规则。</p><p className="mt-2 whitespace-pre-wrap break-words leading-6">{message.intent.imagePrompt}</p></details>}
        {message.error && !message.generation && <p role="alert" className="p-2 text-xs leading-6">{message.error}</p>}
        {active(message) && !message.generation && <p className="p-2 text-xs text-muted-foreground">{Date.now() >= deadline(message) ? "等待较久，请读取任务确认；不会重复调用模型。" : "需求已提交，正在核对图片和尺寸…"}</p>}
        {message.generation && <OwnedGenerationCard compact isImagePlaced={props.isImagePlaced} activityNotice={active(message) && Date.now() >= deadline(message) ? "等待较久，请读取任务确认；不会重复调用模型。" : undefined} task={message.generation} api={props.api} canEdit={!props.readOnly} recoveryDisabled={locked} onReedit={() => reedit(message)} onTask={task => acceptGeneration(message.messageId, task)} onNotice={props.onNotice} onInsert={image => props.onInsert(image, message.intent?.action === "modify" ? message.references.find(ref => ref.referenceId === message.intent?.targetReferenceId)?.shapeId : undefined)} onInsertLayers={props.onInsertLayers} />}
        {ownedConversationChoices(message, "correction").length > 0 && <details className="rounded-xl border border-border p-3 text-xs" data-testid="conversation-correction-options"><summary className="cursor-pointer">判断错了</summary><p className="my-2 leading-6 text-muted-foreground">选择下面的处理方式会重新生成并消耗额度，原图和当前输入都会保留。</p><div className="flex flex-wrap gap-2">{ownedConversationChoices(message, "correction").map(option => <button key={option.id} type="button" className={button} disabled={locked} onClick={() => void send(undefined, { messageId: message.messageId, optionId: option.id, kind: "correction" }).catch(() => undefined)}>{option.label}</button>)}</div></details>}
      </article>)}
      {props.activity}
    </div>
    {error && <div role="alert" className="rounded-xl bg-accent-soft p-3 text-xs leading-6">{error}{ready && !unknown && <button className="ml-2 underline" onClick={() => { setError(""); void flush().catch(() => undefined); }}>确认草稿</button>}</div>}
    {unknown && <div className="space-y-2 rounded-xl border border-border p-3"><p className="text-xs leading-6">上次提交的结果还没确认，需求和引用先保留不动。点“检查上次提交”会读取同一次请求，不会重复扣费。</p><button className={button} disabled={sending || !pending.current || props.readOnly} onClick={() => void send().catch(() => undefined)}>检查上次提交</button></div>}
    <div className="mt-auto shrink-0 space-y-3 rounded-3xl border border-border bg-background p-3">
      <section aria-label="本轮修改对象" className="rounded-2xl border border-border p-2" data-testid="conversation-target">
        <h3 className="mb-1 text-xs font-medium">修改对象</h3>
        {target ? <div className="flex items-center gap-2">
          <img src={`/api/workspaces/${encodeURIComponent(props.workspaceId)}/assets/${encodeURIComponent(target.assetId)}/raw`} alt="" className="h-10 w-12 shrink-0 rounded-lg object-contain" loading="lazy" />
          <span className="min-w-0 flex-1"><span className="block truncate text-xs">{target.name}</span><span className="text-xs text-muted-foreground">本轮修改这张图，原图保留</span></span>
          <button type="button" className="shrink-0 text-xs text-muted-foreground disabled:opacity-40" aria-label="取消修改对象" disabled={locked} onClick={() => { try { chooseCanvasTarget(null); } catch (failure) { setError(explain(failure)); } }}>取消修改</button>
        </div> : <p className="text-xs leading-5 text-muted-foreground">选中画布中的一张图片，或直接描述要创作的新图。</p>}
      </section>
      {!!referenceOnly.length && <section aria-label="仅参考图片"><h3 className="mb-1 text-xs font-medium">仅参考</h3><div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto">{referenceOnly.map(value => <div key={value.referenceId} className="flex max-w-full items-center gap-2 rounded-xl border border-border bg-card p-2">
        <img src={`/api/workspaces/${encodeURIComponent(props.workspaceId)}/assets/${encodeURIComponent(value.assetId)}/raw`} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" loading="lazy" />
        <span className="min-w-0"><span className="block max-w-28 truncate text-xs">{value.name}</span><span className="block text-xs text-muted-foreground">{value.purpose === "EXACT" ? "严格保留 · 规则未变" : value.purpose === "ADAPTIVE" ? "允许融合 · 规则未变" : "仅作视觉参考"}</span>
          {value.shapeId && <button type="button" className="mt-1 text-xs text-primary disabled:opacity-40" aria-label={`设为修改对象 ${value.name}`} title={value.purpose === "EXACT" ? "请先在素材用途中明确调整严格保留规则" : undefined} disabled={locked || value.purpose === "EXACT"} onClick={() => { try { chooseCanvasTarget(value); } catch (failure) { setError(explain(failure)); } }}>设为修改对象</button>}
        </span>
        <button type="button" aria-label={`移除参考 ${value.name}`} className="rounded-full px-1 py-1 text-muted-foreground disabled:opacity-40" disabled={locked} onClick={() => edit({ references: draft.references.filter(ref => ref.referenceId !== value.referenceId) })}>×</button>
      </div>)}</div></section>}
      <textarea ref={input} aria-label="对话设计需求" className="h-24 max-h-40 min-h-16 w-full resize-none bg-transparent text-sm leading-6 outline-none" placeholder={draft.quickEditTargetId ? "描述这张图片要怎么修改" : "输入想法，或添加图片作为参考"} value={draft.text} maxLength={4000} disabled={locked} onChange={event => edit({ text: event.target.value })} onCompositionStart={() => { composing.current = true; if (timer.current) clearTimeout(timer.current); }} onCompositionEnd={() => { composing.current = false; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(() => undefined), 700); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); if (draftRef.current.text.trim()) void send().catch(() => undefined); } }} />
      <div className="flex flex-wrap items-center gap-2" aria-label="本轮输出规格">
            <label className="flex items-center justify-between text-xs">比例<select aria-label="对话图片比例" className={button} value={draft.sizeSelection.ratioKey} disabled={locked} onChange={event => edit({ sizeSelection: { ratioKey: event.target.value as Draft["sizeSelection"]["ratioKey"], resolutionTier: draft.sizeSelection.resolutionTier, ...(event.target.value === "custom" ? { customRatio: { width: 1, height: 1 } } : {}) } })}>{GenerationAspectRatioKey.options.map(value => <option key={value} value={value}>{value === "custom" ? "自定义" : value}</option>)}</select></label>
            {draft.sizeSelection.ratioKey === "custom" && <div className="flex gap-2">{(["width", "height"] as const).map(axis => <input key={axis} aria-label={axis === "width" ? "自定义比例宽" : "自定义比例高"} className="w-20 rounded border border-border bg-background px-2 py-1" type="number" min={1} max={10000} disabled={locked} value={draft.sizeSelection.customRatio?.[axis] ?? 1} onChange={event => edit({ sizeSelection: { ...draft.sizeSelection, customRatio: { width: 1, height: 1, ...draft.sizeSelection.customRatio, [axis]: Number(event.target.value) } } })} />)}</div>}
            <label className="flex items-center justify-between text-xs">画质<select aria-label="对话图片画质" className={button} value={draft.sizeSelection.resolutionTier} disabled={locked} onChange={event => edit({ sizeSelection: { ...draft.sizeSelection, resolutionTier: event.target.value as "1K" | "2K" } })}><option>1K</option><option>2K</option></select></label>
      </div>
      <p className="text-xs leading-5 text-muted-foreground" role="status" data-testid="conversation-size-preview" data-source={sizePreview.source}>{sizePreview.text}</p>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">尺寸以哪一个为准？</summary><p className="mt-1 leading-5">文字像素优先，其次是文字中的比例 / 1K、2K；修改图片且文字未指定尺寸时保留原图像素。其余情况使用上方下拉。要改变修改图尺寸，请在需求里写明；矛盾要求会先确认。这里只预览现有规则，发送后还会校验素材和生成能力。</p></details>
      <div className="flex flex-wrap items-center gap-2">
        {props.onAddReference && <button type="button" className={button} aria-label="添加参考图片" title="从素材库添加参考图片" disabled={locked} onClick={props.onAddReference}>＋ 参考</button>}
        <details className="relative" data-testid="conversation-settings"><summary className={button + " cursor-pointer list-none"} aria-label="生成设置">更多</summary>
          <div className="absolute bottom-full left-0 z-30 mb-2 w-60 space-y-3 rounded-2xl border border-border bg-card p-4 shadow-lg">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label="同时准备可编辑PSD" checked={!!draft.psdLayerMode} disabled={locked} onChange={event => edit({ psdLayerMode: event.target.checked ? "AUTO" : undefined, psdLayerCount: undefined })} />同时准备 PSD</label>
            {draft.psdLayerMode && <><select aria-label="PSD分层方式" className={button} disabled={locked} value={draft.psdLayerMode} onChange={event => edit({ psdLayerMode: event.target.value as "AUTO" | "MANUAL", psdLayerCount: event.target.value === "MANUAL" ? 4 : undefined })}><option value="AUTO">按内容自动分层</option><option value="MANUAL">指定层数</option></select>{draft.psdLayerMode === "MANUAL" && <input aria-label="PSD图层数量" className="w-16 rounded border border-border" type="number" min={2} max={10} value={draft.psdLayerCount} disabled={locked} onChange={event => edit({ psdLayerCount: Number(event.target.value) })} />}<p className="text-xs text-muted-foreground">会额外使用分层服务额度，原图先可用。</p></>}
            {props.onAdvancedSettings && <button className={button} type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); props.onAdvancedSettings?.(); }}>素材用途与输出画框</button>}
          </div>
        </details>
        <span role="status" className="min-w-0 truncate text-xs text-muted-foreground" data-testid="conversation-draft-status" data-saved={ready && !saving && same(draft, confirmedDraft.current!)}>{!ready ? "恢复中…" : saving || !same(draft, confirmedDraft.current!) ? "保存中…" : ""}</span>
        <button className="ml-auto rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40" disabled={locked || !draft.text.trim()} onClick={() => void send().catch(() => undefined)}>{sending ? "正在提交…" : "发送"}</button>
      </div>
    </div>
  </section>;
});
