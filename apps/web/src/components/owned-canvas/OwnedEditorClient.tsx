"use client";

import { useBoundedTaskPoll, TASK_POLL_PAUSED_MESSAGE } from "../../lib/use-bounded-task-poll";

import { useCallback, useEffect, useRef, useState } from "react";
import { StudioMaterial, resolveGenerationSize, type EditorDocumentView } from "@brandai/contracts";
import { NovartApiError } from "../../lib/novart-api-client";
import { ownedCanvasEngine } from "../../lib/owned-canvas-engine";
import { assignOwnedImageNames, type OwnedCanvasDocument, type OwnedCanvasItem } from "../../lib/owned-canvas-model";
import type { OwnedExportOptions } from "../../lib/owned-canvas-export";
import { OwnedCanvas } from "./OwnedCanvas";
import { OwnedWorkflowPanel } from "./OwnedWorkflowPanel";
import { OwnedGenerationCard } from "./OwnedGenerationCard";
import { OwnedLayerPanel } from "./OwnedLayerPanel";
import { OwnedConversationPanel, type OwnedConversationHandle } from "./OwnedConversationPanel";
import { selectedOwnedConversationReferences } from "./owned-conversation-references";
import { OwnedBrandMaterialsDrawer } from "./OwnedBrandMaterialsDrawer";
import { OwnedImageResize } from "./OwnedImageResize";
import { OwnedImageMask } from "./OwnedImageMask";
import { StudioImageToolInput, type StudioImageToolCapabilities } from "@brandai/contracts";
import type { z } from "zod";
import { matchesOwnedPsdSelection, ownedPsdSelection, type OwnedLayerMode } from "./owned-layer-options";
import { generatedOwnedSourceShapeId, placeGeneratedOwnedLayers } from "./owned-generated-layer-placement";
import { createOwnedWorkflowSession, type OwnedWorkflowSession, type WorkflowSessionState } from "./owned-workflow-session";
import { useOwnedDraft } from "./use-owned-draft";
import { createOwnedGenerationRecovery, OwnedGenerationRecoveryError } from "./owned-generation-recovery";
import { takeReadyGenerationImages } from "./owned-generation-autoinsert";
import { nextOwnedImagePosition } from "./owned-image-placement";
import { createOwnedEditorApi, type Material, type UploadTask, type GenerationTask, type PersistentImage, type GenerationInput, type WorkflowInput, type DecompositionTask } from "./owned-editor-api";

type InitialTask = { kind: "STUDIO_UPLOAD" | "STUDIO_GENERATION" | "STUDIO_DECOMPOSITION"; id: string };
export type OwnedEditorClientProps = { workspaceId: string; projectId: string; userId: string; readOnly?: boolean; projectName?: string; initialTask?: InitialTask };
type ProductApi = ReturnType<typeof createOwnedEditorApi>;
const { decodeDocument: decodeOwnedCanvas, encodeDocument: encodeOwnedCanvas, serializeDocument: serializeOwnedDocument,
  exportPng: exportOwnedPng, exportSvg: exportOwnedSvg, getBounds: getOwnedBounds } = ownedCanvasEngine;
type SaveState = "loading" | "saved" | "dirty" | "saving" | "error" | "conflict";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请稍后重试。";
const activeGeneration = (task: GenerationTask) => ["PENDING", "RUNNING"].includes(task.status) || task.status === "SUCCEEDED" && ["NOT_REQUESTED", "PENDING", "RUNNING"].includes(task.resultState);
const mergeTask = <T,>(items: T[], item: T, identity: (value: T) => string) => [item, ...items.filter(value => identity(value) !== identity(item))].slice(0, 50);
const button = "rounded-full border border-border bg-card px-3 py-2 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";
const headerButton = "shrink-0 whitespace-nowrap rounded-full border border-border bg-card px-2 py-2 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 sm:px-3";

export function OwnedEditorClient({ workspaceId, projectId, userId, readOnly = false, projectName = "创作项目", initialTask }: OwnedEditorClientProps) {
  const [document, setDocument] = useState<OwnedCanvasDocument | null>(null);
  const [view, setView] = useState<EditorDocumentView | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [visibleName, setVisibleName] = useState(projectName);
  useEffect(() => setVisibleName(projectName), [projectName, projectId]);
  useEffect(() => { window.document.title = `${visibleName} · DeepFlare`; }, [visibleName]);
  const conversationRef = useRef<OwnedConversationHandle | null>(null);
  const [resizingImage, setResizingImage] = useState<OwnedCanvasItem | null>(null);
  const [maskingImage, setMaskingImage] = useState<{ item: OwnedCanvasItem; material: PersistentImage } | null>(null);
  const [imageTools, setImageTools] = useState<z.infer<typeof StudioImageToolCapabilities> | undefined>();
  const imageToolOperation = useRef<z.infer<typeof StudioImageToolInput> | null>(null), imageToolBusy = useRef(false);
  const [pendingImageTool, setPendingImageTool] = useState(false);
  const imageToolJournal = `deepflare:image-tool-pending:${JSON.stringify([userId, workspaceId, projectId])}`;
  const readOnlyRef = useRef(readOnly); readOnlyRef.current = readOnly;
  const initialTaskKind = initialTask?.kind, initialTaskId = initialTask?.id;
  const [panel, setPanel] = useState<"generate" | "materials" | "tasks" | "layers" | "settings" | null>("generate");
  const toolDialog = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panel || panel === "generate") return;
    const previous = window.document.activeElement as HTMLElement | null;
    const node = toolDialog.current;
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(item => item.getClientRects().length);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPanel("generate"); }
      if (event.key === "Tab") { const items = focusable(), first = items[0], last = items.at(-1); if (!first) return; if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); } }
    };
    node?.addEventListener("keydown", keydown);
    return () => { node?.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, [panel]);
  const [layerTasks, setLayerTasks] = useState<DecompositionTask[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [generations, setGenerations] = useState<GenerationTask[]>([]);
  const [workflowState, setWorkflowState] = useState<WorkflowSessionState | null>(null);
  const managedWorkflowHashes = useRef(new Set<string>());
  useEffect(() => { managedWorkflowHashes.current.clear(); }, [workspaceId, projectId, userId]);
  useEffect(() => {
    for (const value of [...(workflowState?.server?.references ?? []), ...(workflowState?.draft?.references ?? [])]) managedWorkflowHashes.current.add(value.assetSha256);
  }, [workflowState]);
  const [outputFrameId, setOutputFrameId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [focusImageId, setFocusImageId] = useState<string>();
  const placementBusy = useRef(false), failedPlacements = useRef(new Set<string>());
  const [placementRetry, setPlacementRetry] = useState(0), [placementFailed, setPlacementFailed] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<GenerationInput["sizeSelection"]["ratioKey"]>("1:1");
  const [quality, setQuality] = useState<"1K" | "2K">("1K");
  const [preparePsd, setPreparePsd] = useState(false), [psdLayerMode, setPsdLayerMode] = useState<OwnedLayerMode>("AUTO"), [psdLayerCount, setPsdLayerCount] = useState(4);
  const psdSelectionRestored = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const [generationRecoveryBlocked, setGenerationRecoveryBlocked] = useState(false);
  const [pendingUpload, setPendingUpload] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const generationPoll = useBoundedTaskPoll({ taskKey: JSON.stringify([workspaceId, userId, projectId]), active: generations.some(activeGeneration) });
  const { timedOut: generationPollTimedOut, expired: generationPollExpired, remaining: generationPollRemaining, resume: resumeGenerationPoll } = generationPoll;
  const apiRef = useRef<ProductApi | null>(null), alive = useRef(false), docRef = useRef<OwnedCanvasDocument | null>(null);
  const viewRef = useRef<EditorDocumentView | null>(null), writableRef = useRef(false), savedSequence = useRef(0), sequence = useRef(0);
  const saveBusy = useRef(false), saveBlocked = useRef(false), pendingSave = useRef<{ canvas: string; sequence: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null), uploadInput = useRef<HTMLInputElement>(null);
  const generationOperation = useRef<GenerationInput | null>(null), uploadOperation = useRef<{ file: File; mutationId: string; point?: { x: number; y: number }; sourceShapeId?: string } | null>(null);
  const refreshBusy = useRef(false), generationBusy = useRef(false), uploadBusy = useRef(false);
  const handoffBusy = useRef(false);
  const replacementOperation = useRef<{ api: ProductApi; itemId: string; file: File; mutationId: string } | null>(null);
  const workflowRef = useRef<OwnedWorkflowSession | null>(null), generationMode = useRef<"generate" | "modify" | null>(null), taskFocusBusy = useRef(false);
  const recoveryRef = useRef<ReturnType<typeof createOwnedGenerationRecovery> | null>(null);
  const canEdit = !!document && ownedCanvasEngine.canEdit(document, readOnly || !!view?.readOnly) && saveState !== "conflict";
  writableRef.current = canEdit;
  const workflow = workflowState?.draft;
  const draft = useOwnedDraft({ workspaceId, projectId, userId, value: { prompt, ratio, quality, ...(outputFrameId ? { outputFrameId } : {}) },
    onRestore: value => { setPrompt(value.prompt); setRatio(value.ratio); setQuality(value.quality); setOutputFrameId(value.outputFrameId ?? ""); },
    readOnly: readOnly || !!view?.readOnly || !!document?.warnings.length, frozen: pendingGeneration || submitting || generationRecoveryBlocked });
  const { flush: flushDraft, confirmed: draftConfirmed } = draft;

  const clearGenerationIntent = useCallback(() => {
    const input = generationOperation.current, mode = generationMode.current;
    if (input && mode) {
      if (!recoveryRef.current) throw new Error("上一份创作的确认记录暂不可读，请先查看服务器任务。");
      recoveryRef.current.clear({ input, mode });
    }
    generationOperation.current = null; generationMode.current = null; setPendingGeneration(false); setGenerationRecoveryBlocked(false);
  }, []);

  const send = useCallback((action: string, extra: Record<string, unknown> = {}) => {
    if (window.parent !== window) window.parent.postMessage({ type: "nv-studio", action, projectId, ...extra }, window.location.origin);
  }, [projectId]);

  const save = useCallback(async (): Promise<EditorDocumentView | null> => {
    const api = apiRef.current, doc = docRef.current;
    if (!api || !doc || !writableRef.current || saveBlocked.current) return viewRef.current;
    if (saveBusy.current) throw new Error("正在保存上一份修改，请稍后再试。");
    if (!pendingSave.current && savedSequence.current === sequence.current) return viewRef.current;
    saveBusy.current = true; setSaveState("saving"); setSaveError("");
    try {
      const snapshotSequence = sequence.current;
      const operation = pendingSave.current ?? { canvas: await encodeOwnedCanvas(doc), sequence: snapshotSequence };
      if (!alive.current || apiRef.current !== api) return null;
      // Keep the exact bytes and mutation identity if the acknowledgement is lost.
      pendingSave.current = operation;
      const saved = await api.session.save(operation.canvas);
      if (!alive.current || apiRef.current !== api) return null;
      pendingSave.current = null; viewRef.current = saved; savedSequence.current = operation.sequence;
      if (alive.current) {
        setView(saved); setSaveState(savedSequence.current === sequence.current ? "saved" : "dirty");
        send("saved", { revision: saved.revision, updatedAt: saved.updatedAt });
      }
      return saved;
    } catch (error) {
      if (apiRef.current !== api) return null;
      if (!api.session.pending) pendingSave.current = null;
      const conflict = error instanceof NovartApiError && error.status === 409;
      if (conflict) saveBlocked.current = true;
      if (alive.current) { setSaveError(messageOf(error)); setSaveState(conflict ? "conflict" : "error"); }
      throw error;
    } finally { if (apiRef.current === api) saveBusy.current = false; }
  }, [send]);

  const saveSettled = useCallback(async () => {
    const api = apiRef.current, deadline = Date.now() + 25_000;
    // Auto-focus can commit the new viewport just after an image insertion.
    // Acknowledge the latest scene, never an earlier successfully saved snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      while (saveBusy.current && Date.now() < deadline && alive.current && apiRef.current === api) await new Promise(resolve => setTimeout(resolve, 50));
      if (!alive.current || apiRef.current !== api) return null;
      if (Date.now() >= deadline) throw new Error("画布保存等待较久，请保留页面并稍后确认。");
      const receipt = await save();
      await new Promise(resolve => setTimeout(resolve, 30));
      if (!alive.current || apiRef.current !== api) return null;
      if (receipt && sequence.current === savedSequence.current && !pendingSave.current && !saveBlocked.current) return receipt;
    }
    throw new Error("画布仍有新的修改，请稍后确认保存。");
  }, [save]);

  const changeDocument = useCallback((next: OwnedCanvasDocument) => {
    if (!writableRef.current) return;
    const previousSequence = Number((docRef.current?.source.novartOwnedCanvas as { imageSequence?: number })?.imageSequence) || 0;
    // Undo deletes the object, not the acknowledgement that this result was
    // delivered. Otherwise refresh would silently undo the user's undo.
    const acknowledged = [...new Set([...(Array.isArray(docRef.current?.source.novartPlacedGenerations) ? docRef.current.source.novartPlacedGenerations as string[] : []), ...(Array.isArray(next.source.novartPlacedGenerations) ? next.source.novartPlacedGenerations as string[] : [])])];
    const named = assignOwnedImageNames({ ...next, source: { ...next.source, novartPlacedGenerations: acknowledged } }, previousSequence);
    docRef.current = named; sequence.current++; setDocument(named);
    if (!saveBusy.current && !pendingSave.current) setSaveState("dirty");
  }, []);

  const insertImage = useCallback(async (material: PersistentImage, point?: { x: number; y: number }, identity?: string, sourceShapeId?: string) => {
    if (!writableRef.current || !docRef.current || !apiRef.current) throw new Error("当前画布只读，无法加入图片。");
    const api = apiRef.current; api.image(material);
    await new Promise<void>((resolve, reject) => {
      const image = new Image(), timer = setTimeout(() => { image.src = ""; reject(new Error("图片读取超时，素材仍保留在库中，可再次加入。")); }, 20000);
      image.onload = () => { clearTimeout(timer); image.naturalWidth === material.width && image.naturalHeight === material.height ? resolve() : reject(new Error("图片尺寸与存储结果不一致，请刷新素材后重试。")); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("图片暂时无法读取，请检查存储后重试。")); }; image.src = material.url;
    });
    if (!alive.current || apiRef.current !== api) return;
    if (!writableRef.current || !docRef.current) throw new Error("画布已变为只读，素材仍保留，图片尚未加入。");
    const current = docRef.current, longest = Math.max(material.width, material.height), scale = Math.min(900 / longest, Math.max(1, 100 / longest));
    const w = material.width * scale, h = material.height * scale;
    const center = point ?? nextOwnedImagePosition(current, w, h, sourceShapeId);
    const id = identity ?? "shape:" + crypto.randomUUID();
    changeDocument({ ...current, items: [...current.items, { id, kind: "image", x: center.x - w / 2, y: center.y - h / 2, w, h, rotation: 0, opacity: 1, parentId: current.pageId, url: material.url, assetId: material.assetId, assetSha256: material.assetSha256, ...(material.versionId ? { versionId: material.versionId } : {}), ...(sourceShapeId ? { sourceShapeId } : {}) }] });
    if (!point) setFocusImageId(id);
    setNotice("图片已加入画布，保存状态见顶部。");
  }, [changeDocument]);

  // Recover unplaced durable results too; the saved ledger prevents repeated
  // insertion after refresh or an intentional undo/delete.
  const watchedGenerations = useRef(new Set<string>()), placedGenerations = useRef(new Set<string>());
  useEffect(() => { watchedGenerations.current = new Set(); placedGenerations.current = new Set(); failedPlacements.current.clear(); setPlacementFailed(false); }, [workspaceId, projectId, userId]);
  useEffect(() => {
    if (!canEdit || placementBusy.current) return;
    const context = apiRef.current;
    const ready = takeReadyGenerationImages(generations.filter(task => task.projectId === projectId), watchedGenerations.current, placedGenerations.current, docRef.current).filter(value => !failedPlacements.current.has(value.task.requestId));
    if (!ready.length) return;
    void (async () => {
      placementBusy.current = true;
      let count = 0;
      try { for (const { task, images } of ready) {
        try {
          for (const image of images) {
            if (!alive.current || apiRef.current !== context) return;
            if (docRef.current?.items.some(item => item.assetId === image.assetId && item.assetSha256 === image.assetSha256)) continue;
            await insertImage(image, undefined, undefined, task.sourceShapeId); count++;
          }
          if (!alive.current || apiRef.current !== context || !docRef.current) return;
          const current = docRef.current;
          changeDocument({ ...current, source: { ...current.source, novartPlacedGenerations: [...new Set([...(Array.isArray(current.source.novartPlacedGenerations) ? current.source.novartPlacedGenerations as string[] : []), task.requestId])] } });
          placedGenerations.current.add(task.requestId);
        } catch (error) { failedPlacements.current.add(task.requestId); setPlacementFailed(true); setNotice(messageOf(error)); }
      }
      if (count) setNotice(`${count} 张新图片已自动加入画布，可撤销。`);
      } finally { if (apiRef.current === context) { placementBusy.current = false; if (alive.current) setPlacementRetry(value => value + 1); } }
    })();
  }, [projectId, generations, canEdit, insertImage, changeDocument, placementRetry]);

  const refresh = useCallback(async (quiet = false) => {
    const api = apiRef.current;
    if (!api || refreshBusy.current) return;
    refreshBusy.current = true; if (!quiet) { setRefreshing(true); resumeGenerationPoll(); setPollPaused(false); }
    try {
      const values = await Promise.allSettled([api.listMaterials(), api.listUploads(), api.listGenerations()]);
      if (!alive.current || apiRef.current !== api) return;
      if (values[0].status === "fulfilled") setMaterials(values[0].value);
      if (values[1].status === "fulfilled") setUploads(values[1].value);
      if (values[2].status === "fulfilled") {
        setGenerations(values[2].value);
        if (!psdSelectionRestored.current) {
          const selection = ownedPsdSelection(generationOperation.current ?? values[2].value[0]);
          setPreparePsd(selection.requested); setPsdLayerMode(selection.requested ? selection.mode : "AUTO"); setPsdLayerCount(selection.count); psdSelectionRestored.current = true;
        }
        const accepted = values[2].value.find(task => task.mutationId === generationOperation.current?.mutationId);
        if (accepted && accepted.mode === generationMode.current && generationOperation.current && matchesOwnedPsdSelection(generationOperation.current, accepted)) {
          try { clearGenerationIntent(); } catch (error) { setNotice(messageOf(error)); }
        }
      }
      const failure = values.find(value => value.status === "rejected");
      if (failure?.status === "rejected") { setNotice(messageOf(failure.reason)); if (quiet) setPollPaused(true); }
    } finally { if (apiRef.current === api) { refreshBusy.current = false; if (alive.current) setRefreshing(false); } }
  }, [clearGenerationIntent, resumeGenerationPoll]);

  const openExistingTask = useCallback(async (kind: InitialTask["kind"], id: string) => {
    const api = apiRef.current;
    if (!api || !docRef.current || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !["STUDIO_UPLOAD", "STUDIO_GENERATION", "STUDIO_DECOMPOSITION"].includes(kind)) throw new Error("任务不属于当前画布或画布尚未就绪。");
    if (taskFocusBusy.current) throw new Error("正在读取上一条任务，请稍后重试。");
    taskFocusBusy.current = true;
    try {
      if (kind === "STUDIO_UPLOAD") { const task = await api.getUpload(id); if (!alive.current || apiRef.current !== api) return false; setUploads(current => mergeTask(current, task, value => value.taskId)); }
      else if (kind === "STUDIO_GENERATION") { const task = await api.getGeneration(id); if (!alive.current || apiRef.current !== api) return false; setGenerations(current => mergeTask(current, task, value => value.requestId)); }
      else { await api.getDecomposition(id); if (!alive.current || apiRef.current !== api) return false; }
      setPanel(kind === "STUDIO_DECOMPOSITION" ? "layers" : "tasks"); setNotice("已展开服务器中的任务记录，是否加入画布由你决定。"); return true;
    } finally { if (apiRef.current === api) taskFocusBusy.current = false; }
  }, []);

  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    const api = createOwnedEditorApi(workspaceId, projectId, userId, { signal: controller.signal }); apiRef.current = api;
    const workflowSession = createOwnedWorkflowSession(api, { canWrite: () => writableRef.current, saveDocument: async () => {
      const saved = await save();
      if (!alive.current || apiRef.current !== api || !saved || sequence.current !== savedSequence.current || pendingSave.current || saveBlocked.current) throw new Error("画布保存尚未确认，请保存后再设置用途。");
    } });
    workflowRef.current = workflowSession; const stopWorkflow = workflowSession.subscribe(setWorkflowState);
    setGenerations([]); setMaterials([]); setUploads([]); setLayerTasks([]);
    setSaveState("loading"); setSaveError(""); setDocument(null); setView(null); docRef.current = null; viewRef.current = null; sequence.current = 0; savedSequence.current = 0;
    pendingSave.current = null; saveBlocked.current = false;
    placementBusy.current = false; saveBusy.current = false; refreshBusy.current = false; uploadBusy.current = false; generationBusy.current = false; handoffBusy.current = false; taskFocusBusy.current = false;
    generationMode.current = null; setSelectedIds([]);
    psdSelectionRestored.current = false; setPreparePsd(false); setPsdLayerMode("AUTO"); setPsdLayerCount(4);
    uploadOperation.current = null; generationOperation.current = null; setPendingUpload(false); setPendingGeneration(false);
    recoveryRef.current = null; setGenerationRecoveryBlocked(false);
    imageToolOperation.current = null; imageToolBusy.current = false; setPendingImageTool(false); setMaskingImage(null); setResizingImage(null); setImageTools(undefined);
    try { const stored = localStorage.getItem(imageToolJournal); if (stored) { imageToolOperation.current = StudioImageToolInput.parse(JSON.parse(stored)); setPendingImageTool(true); } }
    catch { setPendingImageTool(true); setNotice("暂时读不到上次图片编辑的提交记录，请先到任务记录查看，不会自动重复提交。"); }
    void api.getImageToolCapabilities().then(value => { if (alive.current && apiRef.current === api) setImageTools(value); }).catch(() => undefined);
    try {
      const recovery = createOwnedGenerationRecovery({ workspaceId, projectId, userId }); recoveryRef.current = recovery;
      const pending = recovery.load();
      if (pending) {
        generationOperation.current = pending.input; generationMode.current = pending.mode; setPendingGeneration(true);
        const selection = ownedPsdSelection(pending.input);
        setPreparePsd(selection.requested); setPsdLayerMode(selection.requested ? selection.mode : "AUTO"); setPsdLayerCount(selection.count); psdSelectionRestored.current = true;
        setNotice("上次创作的提交结果还没确认。原请求已保留，请到任务记录查看，或点“检查上次生成”；不会自动重新提交。");
      }
    } catch (error) { setGenerationRecoveryBlocked(true); setNotice(messageOf(error)); }
    void api.session.load().then(async result => {
      const decoded = await decodeOwnedCanvas(result.canvas);
      const loaded = !readOnlyRef.current && !result.readOnly ? assignOwnedImageNames(decoded) : decoded;
      if (!alive.current || apiRef.current !== api) return;
      docRef.current = loaded; viewRef.current = result; setView(result); setDocument(loaded);
      if (loaded !== decoded) { sequence.current++; setSaveState("dirty"); } else setSaveState("saved");
      void refresh(); void workflowSession.load();
      if (initialTaskKind && initialTaskId) void openExistingTask(initialTaskKind, initialTaskId).catch(error => { if (alive.current && apiRef.current === api) setNotice(messageOf(error)); });
    }).catch(error => {
      if (!alive.current || apiRef.current !== api) return;
      setSaveError(messageOf(error)); setSaveState("error"); send("startup-error", { code: "OWNED_CANVAS_LOAD_FAILED" });
    });
    return () => { alive.current = false; workflowSession.dispose(); stopWorkflow(); controller.abort(); if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [workspaceId, projectId, userId, refresh, send, save, openExistingTask, initialTaskKind, initialTaskId, imageToolJournal]);

  useEffect(() => {
    if (!document) return;
    window.document.documentElement.dataset.nvStudioCanvasReady = "true";
    send("ready");
    return () => { window.document.documentElement.dataset.nvStudioCanvasReady = "false"; };
    // A restored document must render before the shell drops its loading cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(document), send]);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (saveState === "dirty" && canEdit) saveTimer.current = setTimeout(() => { void save().catch(() => undefined); }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [document, saveState, canEdit, save]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (sequence.current !== savedSequence.current || pendingSave.current || workflowRef.current?.snapshot().dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    const keyboard = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save().catch(() => undefined); } };
    const command = (event: MessageEvent) => {
      const data = event.data;
      if (event.origin === location.origin && event.source === parent && parent !== window && data?.type === "novart-product-task-open"
        && data.workspaceId === workspaceId && data.userId === userId && data.projectId === projectId
        && typeof data.token === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.token)
        && typeof data.taskId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.taskId) && ["STUDIO_UPLOAD", "STUDIO_GENERATION", "STUDIO_DECOMPOSITION"].includes(data.kind)) {
        const api = apiRef.current;
        const reply = (ok: boolean, error?: string) => { if (alive.current && apiRef.current === api) parent.postMessage({ type: "novart-product-task-opened", workspaceId, userId, projectId, kind: data.kind, taskId: data.taskId, token: data.token, ok, ...(error ? { error } : {}) }, location.origin); };
        void openExistingTask(data.kind, data.taskId).then(opened => { if (opened) reply(true); }).catch(error => reply(false, messageOf(error))); return;
      }
      if (event.origin !== location.origin || event.source !== parent || !data || data.type !== "nv-studio" || data.projectId !== projectId) return;
      if (data.action === "project-renamed" && typeof data.projectName === "string" && data.projectName.trim().length >= 1 && data.projectName.trim().length <= 200) {
        setVisibleName(data.projectName.trim()); return;
      }
      if (data.action === "start-creation") {
        if (parent === window || typeof data.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.requestId)) return;
        const api = apiRef.current, requestId = data.requestId;
        const reply = (status: "accepted" | "failed", error?: string) => { if (alive.current && apiRef.current === api) send("start-creation-result", { requestId, status, ...(error ? { error } : {}) }); };
        if (!api || handoffBusy.current) { reply("failed", "正在确认上一份保存，请稍后继续。"); return; }
        handoffBusy.current = true;
        void (async () => {
          try {
            const deadline = Date.now() + 20_000;
            while (alive.current && apiRef.current === api && (!conversationRef.current?.ready() || workflowRef.current?.snapshot().busy || workflowRef.current?.snapshot().status === "loading" || saveBusy.current)) {
              if (Date.now() >= deadline) throw new Error("创作页面准备较久，原需求仍保留，可稍后继续。");
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!alive.current || apiRef.current !== api) return;
            if (!writableRef.current || !docRef.current || !conversationRef.current) throw new Error("创作页面尚未恢复，请稍后继续。");
            if (typeof data.text !== "string" || !data.text.trim() || data.text.length > 4000 || !Array.isArray(data.referenceShapeIds) || data.referenceShapeIds.length > 8 || data.referenceShapeIds.some((id: unknown) => typeof id !== "string" || !/^shape:home-[a-f0-9-]{36}$/i.test(id))) throw new Error("首页创作内容无法确认，原需求仍保留。");
            const saved = await saveSettled();
            if (!saved || sequence.current !== savedSequence.current || pendingSave.current || saveBlocked.current) throw new Error("请先确认画布已保存，再继续创作。");
            const refs = selectedOwnedConversationReferences(docRef.current, data.referenceShapeIds, await api.listMaterials());
            if (!alive.current || apiRef.current !== api) return;
            await conversationRef.current.startHome(data.text, requestId, refs);
            if (!alive.current || apiRef.current !== api) return;
            setPanel("generate"); reply("accepted");
          } catch (error) { reply("failed", messageOf(error)); }
          finally { if (apiRef.current === api) handoffBusy.current = false; }
        })(); return;
      }
      if (["insert-material", "confirm-save", "confirm-leave"].includes(data.action)) {
        if (typeof data.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.requestId)) return;
        const action = data.action === "insert-material" ? "insert-material-result" : data.action === "confirm-leave" ? "confirm-leave-result" : "confirm-save-result";
        const api = apiRef.current;
        if (!api || handoffBusy.current) { send(action, { requestId: data.requestId, status: "failed", error: "正在确认上一份保存，请稍后继续。" }); return; }
        handoffBusy.current = true;
        void (async () => {
          try {
            if (!docRef.current) throw new Error("画布还没有恢复完成，请稍后再试。");
            if (data.action === "confirm-leave") {
              if (uploadBusy.current || generationBusy.current || refreshBusy.current || taskFocusBusy.current) throw new Error("创作或素材操作正在处理，请完成后再切换品牌。");
              await flushDraft();
              await conversationRef.current?.flush();
              const workflow = workflowRef.current;
              if (workflow?.snapshot().dirty) await workflow.save();
              const state = workflow?.snapshot();
              if (!state || state.busy || state.dirty || state.status !== "ready") throw new Error("素材用途尚未确认保存，请返回工作台确认后再切换品牌。");
            }
            if (data.action === "insert-material") {
              if (!writableRef.current) throw new Error("画布当前只读，图片和需求仍保留。");
              const material = StudioMaterial.parse(data.material); api.image(material);
              const stored = (await api.listMaterials()).find(value => value.assetId === material.assetId && value.assetSha256 === material.assetSha256
                && value.url === material.url && value.width === material.width && value.height === material.height);
              if (!stored) throw new Error("图片还未确认存入当前品牌，请刷新上传任务后继续。");
              if (!alive.current || apiRef.current !== api) return;
              const id = "shape:home-" + data.requestId;
              const existing = docRef.current?.items.find(item => item.id === id);
              if (existing && (existing.assetId !== stored.assetId || existing.assetSha256 !== stored.assetSha256)) throw new Error("交接记录与素材不一致，原内容保留。");
              if (!existing) await insertImage(stored, undefined, id);
              const inserted = docRef.current?.items.find(item => item.id === id);
              if (!writableRef.current || !inserted || inserted.kind !== "image" || inserted.assetId !== stored.assetId
                || inserted.assetSha256 !== stored.assetSha256 || inserted.url !== stored.url) throw new Error("图片还未确认加入可编辑画布，恢复记录仍保留。");
            }
            const saved = await saveSettled();
            if (!alive.current || apiRef.current !== api) return;
            if (!saved || sequence.current !== savedSequence.current || pendingSave.current || saveBlocked.current) throw new Error("画布修改尚未确认保存，请稍后继续。");
            if (data.action === "confirm-leave" && (!draftConfirmed() || conversationRef.current && !conversationRef.current.confirmed() || workflowRef.current?.snapshot().dirty)) throw new Error("仍有新的需求或素材修改，请确认保存后再切换品牌。");
            send(action, { requestId: data.requestId, status: "saved", revision: saved.revision });
          } catch (error) {
            if (alive.current && apiRef.current === api) send(action, { requestId: data.requestId, status: "failed", error: error instanceof Error && error.name === "ZodError" ? "素材结果格式无法确认，原文件保留。" : messageOf(error) });
          } finally { if (apiRef.current === api) handoffBusy.current = false; }
        })();
        return;
      }
      if (data.action === "preferences" && ["system", "reduce"].includes(data.motion)) window.document.documentElement.dataset.nvStudioMotion = data.motion;
      if (data.action !== "open-panel") return;
      if (data.panel === "requirements") setPanel("generate");
      else if (data.panel === "materials") setPanel("materials");
      else if (data.panel === "upload" && writableRef.current) uploadInput.current?.click();
      else { send("panel-result", { panel: data.panel, status: "unavailable" }); return; }
      send("panel-result", { panel: data.panel, status: "opened" });
    };
    window.addEventListener("beforeunload", preventLoss); window.addEventListener("keydown", keyboard); window.addEventListener("message", command);
    return () => { window.removeEventListener("beforeunload", preventLoss); window.removeEventListener("keydown", keyboard); window.removeEventListener("message", command); };
  }, [workspaceId, userId, projectId, saveSettled, save, send, openExistingTask, flushDraft, draftConfirmed, insertImage]);

  useEffect(() => {
    if (!generations.some(activeGeneration) || pollPaused || generationPollTimedOut) return;
    const timer = setTimeout(() => { if (!generationPollExpired()) void refresh(true); }, Math.min(3500, generationPollRemaining()));
    return () => clearTimeout(timer);
  }, [generations, pollPaused, refresh, generationPollTimedOut, generationPollExpired, generationPollRemaining]);
  useEffect(() => {
    if (generationPoll.timedOut) setNotice(TASK_POLL_PAUSED_MESSAGE);
  }, [generationPoll.timedOut]);


  async function prepareLayers() {
    const saved = await saveSettled();
    if (!alive.current || !writableRef.current || !docRef.current || !saved || sequence.current !== savedSequence.current
      || pendingSave.current || saveBlocked.current) throw new Error("画布保存尚未确认，请先保存后再提交分层。");
    return { document: docRef.current, revision: saved.revision };
  }
  async function prepareConversation() {
    const saved = await prepareLayers(), workflow = workflowRef.current;
    if (!workflow) throw new Error("素材设置尚未读取，请稍后再试。");
    if (workflow.snapshot().dirty) await workflow.save();
    else await workflow.load();
    const state = workflow.snapshot();
    if (!writableRef.current || state.dirty || state.busy || state.status !== "ready" || !state.server) throw new Error("素材设置尚未确认，请读取最新设置。");
    return { documentRevision: saved.revision, workflowRevision: state.server.revision, ...(outputFrameId ? { outputFrameId } : {}) };
  }
  async function applyWorkflowToConversation() {
    const prepared = await prepareLayers(), state = workflowRef.current?.snapshot().draft;
    if (!state || !apiRef.current || !conversationRef.current) throw new Error("素材设置还未准备好。");
    const ids = state.references.filter(value => value.participates && value.shapeId).map(value => value.shapeId!);
    const materials = await apiRef.current.listMaterials();
    const refs = selectedOwnedConversationReferences(prepared.document, ids, materials);
    refs.forEach(ref => { ref.purpose = state.references.find(value => value.shapeId === ref.shapeId)?.purpose ?? "REFERENCE"; });
    for (const ref of state.references.filter(value => value.participates && !value.shapeId)) {
      const material = materials.find(value => value.assetSha256 === ref.assetSha256);
      if (!material || !ref.purpose) throw new Error("有参与素材尚未确认可用，原选择仍保留。");
      refs.push({ referenceId: "brand:" + material.assetId, name: material.fileName, assetId: material.assetId, assetSha256: material.assetSha256, width: material.width, height: material.height, purpose: ref.purpose });
    }
    conversationRef.current.configureReferences(refs, [...managedWorkflowHashes.current, ...state.references.map(value => value.assetSha256)]);
    setPanel("generate");
  }
  async function imageAction(action: "quick-edit" | "add-reference" | "layers" | "resize" | "remove-background" | "inpaint", ids: string[]) {
    if (action === "layers") { setSelectedIds(ids); setPanel("layers"); return; }
    if (action === "resize") { const item = docRef.current?.items.find(value => value.id === ids[0]); if (writableRef.current && item?.kind === "image") setResizingImage({ ...item }); return; }
    try {
      const saved = await prepareLayers(), api = apiRef.current;
      if (!api) throw new Error("素材服务尚未准备完成。");
      const references = selectedOwnedConversationReferences(saved.document, ids, await api.listMaterials());
      if (action === "inpaint") {
        const item = saved.document.items.find(value => value.id === ids[0]), material = (await api.listMaterials()).find(value => value.assetId === item?.assetId && value.assetSha256 === item?.assetSha256);
        if (!item || !material) throw new Error("原图片还未确认持久化。");
        if (item.crop || item.flipX || item.flipY || Math.abs(item.rotation) > 1e-6) throw new Error("请先重置这张图片的裁切、翻转和旋转，再涂抹原图。");
        setMaskingImage({ item: { ...item }, material }); return;
      }
      if (action === "remove-background") { await submitImageTool("remove-background", ids[0]!); return; }
      if (!conversationRef.current) throw new Error("对话还未恢复，请稍后再试。");
      conversationRef.current.addReferences(references, action === "quick-edit" ? references[0]?.referenceId : undefined);
      setPanel("generate"); setNotice(action === "quick-edit" ? "编辑目标已固定，请描述这张图片要如何修改。" : "图片已加入对话；改变画布选择不会替换这些引用。");
    } catch (error) { setNotice(messageOf(error)); }
  }
  async function submitImageTool(operation: "remove-background" | "inpaint", itemId: string, mask?: string, instruction?: string) {
    const api = apiRef.current;
    if (!api || !writableRef.current || imageToolBusy.current) throw new Error("图片工具暂不可用，请稍后再试。");
    imageToolBusy.current = true;
    try {
      let input = imageToolOperation.current;
      if (!input) {
        if (pendingImageTool) throw new Error("请先确认上一份图片工具请求。");
        const prepared = await prepareConversation(), item = docRef.current?.items.find(value => value.id === itemId);
        if (!item?.assetSha256 || item.kind !== "image") throw new Error("原图片已变化，请重新选择。");
        input = StudioImageToolInput.parse({ projectId, mutationId: crypto.randomUUID(), documentRevision: prepared.documentRevision, workflowRevision: prepared.workflowRevision,
          target: { shapeId: itemId, assetSha256: item.assetSha256 }, operation, ...(mask ? { mask } : {}), ...(instruction?.trim() ? { instruction: instruction.trim() } : {}) });
        localStorage.setItem(imageToolJournal, JSON.stringify(input)); imageToolOperation.current = input; setPendingImageTool(true);
      } else if (input.operation !== operation || input.target.shapeId !== itemId || mask && input.mask !== mask) throw new Error("上次图片编辑的结果还没确认，请先到任务记录查看。");
      const task = await api.submitImageTool(input);
      if (!alive.current || apiRef.current !== api) return;
      setGenerations(current => mergeTask(current, task, value => value.requestId)); localStorage.removeItem(imageToolJournal); imageToolOperation.current = null; setPendingImageTool(false);
      generationPoll.resume(); setPollPaused(false); setPanel("tasks"); setNotice("图片工具已提交，原图保留。结果会在任务中显示，关闭页面后仍会继续处理。");
    } catch (error) {
      if (error instanceof NovartApiError && !error.uncertain && error.status !== null && error.status >= 400 && error.status < 500) { localStorage.removeItem(imageToolJournal); imageToolOperation.current = null; setPendingImageTool(false); }
      if (alive.current && apiRef.current === api) setNotice(messageOf(error)); throw error;
    } finally { if (apiRef.current === api) imageToolBusy.current = false; }
  }
  async function insertLayers(task: DecompositionTask, suppliedSource?: PersistentImage) {
    const api = apiRef.current;
    if (!api || !writableRef.current || !docRef.current) throw new Error("当前画布不可编辑，图层仍保存在任务中。");
    if (task.projectId !== projectId || task.status !== "SUCCEEDED" || task.layers.length < 2
      || task.layers.reduce((sum, layer) => sum + layer.width * layer.height, 0) > 40_000_000) throw new Error("图层还未完整保存或超过画布内存预算。");
    let source = suppliedSource;
    if (task.sourceShapeId === await generatedOwnedSourceShapeId(task.assetId) && !source) source = (await api.listMaterials()).find(image => image.assetId === task.assetId && image.assetSha256 === task.assetSha256);
    if (source) api.image(source);
    // Decode sequentially instead of allocating every full-resolution raster
    // at once. The overall wait has an exit even when image responses stall.
    const deadline = Date.now() + 60_000;
    for (const layer of task.layers) {
      api.image(layer);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("图层读取超时，原图未改动，可稍后重新展开。");
      await new Promise<void>((resolve, reject) => {
        const image = new Image(), timer = setTimeout(() => { image.src = ""; reject(new Error("图层读取超时，原图未改动。")); }, Math.min(20_000, remaining));
        image.onload = () => { clearTimeout(timer); image.naturalWidth === layer.width && image.naturalHeight === layer.height ? resolve() : reject(new Error("图层尺寸与保存结果不一致，原图未改动。")); };
        image.onerror = () => { clearTimeout(timer); reject(new Error("图层暂时无法读取，原图未改动。")); }; image.src = layer.url;
      });
      if (!alive.current || apiRef.current !== api || !writableRef.current) throw new Error("页面状态已变化，图层尚未加入画布。");
    }
    const before = docRef.current;
    if (!before) throw new Error("画布尚未准备完成。");
    const placed = await placeGeneratedOwnedLayers(before, task, workspaceId, source, selectedIds, { besideSource: true });
    if (!alive.current || apiRef.current !== api || !writableRef.current || docRef.current !== before) throw new Error("画布刚刚发生变化，请重新展开图层，原内容仍保留。");
    if (!placed.replayed) { changeDocument(placed.document); setFocusImageId(placed.itemIds[0]); }
    setNotice(placed.replayed ? "这一组图层已经在画布中，保留当前编辑。" : "图层已在原图右侧展开。原图保留，可解除组合后分别编辑。");
    await saveSettled();
  }

  async function runUpload() {
    const api = apiRef.current, operation = uploadOperation.current;
    if (!api || !operation || uploadBusy.current || !writableRef.current) return;
    uploadBusy.current = true; setUploading(true); setPanel("generate");
    try {
      setNotice("正在提交图片…");
      const task = await api.uploadFile(operation.file, operation.mutationId);
      if (!alive.current || apiRef.current !== api) return;
      uploadOperation.current = null; setPendingUpload(false);
      const accept = (value: UploadTask) => { if (alive.current && apiRef.current === api) setUploads(current => mergeTask(current, value, item => item.taskId)); };
      accept(task); setNotice("图片已提交，关闭页面后仍会继续保存。");
      const result = await api.pollUpload(task, accept);
      if (!alive.current || apiRef.current !== api) return;
      if (result.status === "FAILED") throw new Error(result.error || "图片保存失败，请重新选择。");
      if (result.status === "SUCCEEDED" && result.material) { await insertImage(result.material, operation.point, undefined, operation.sourceShapeId); void refresh(); return true; }
      else setNotice("图片还在处理中，自动等待已结束。请刷新任务，完成后可加入画布。");
    } catch (error) {
      if (apiRef.current !== api) return;
      if (error instanceof NovartApiError && !error.uncertain) { uploadOperation.current = null; setPendingUpload(false); }
      if (alive.current) { setPendingUpload(!!uploadOperation.current); setNotice(messageOf(error)); }
    } finally { if (apiRef.current === api) { uploadBusy.current = false; if (alive.current) setUploading(false); } }
  }
  async function uploadFiles(files: File[], point?: { x: number; y: number }) {
    if (!writableRef.current) return;
    if (files.length !== 1) { setNotice("请一次选择一张图片，保存后可继续上传。"); setPanel("materials"); return; }
    if (uploadOperation.current || uploadBusy.current) { setNotice("请先确认上一张图片的上传结果。"); setPanel("tasks"); return; }
    uploadOperation.current = { file: files[0]!, mutationId: crypto.randomUUID(), point }; setPendingUpload(true);
    await runUpload();
  }

  async function replaceImage(itemId: string, files: File[]): Promise<Pick<OwnedCanvasItem, "url" | "assetId" | "assetSha256" | "versionId"> | null> {
    const api = apiRef.current;
    if (!api || !writableRef.current || !docRef.current) throw new Error("当前画布不可编辑，原图片仍保留。");
    const target = docRef.current.items.find(item => item.id === itemId);
    if (!target || target.kind !== "image" || target.locked || target.hidden) throw new Error("请先选中可编辑的图片。");
    if (files.length !== 1) throw new Error("替换图片请一次选择一张。");
    if (uploadBusy.current || uploadOperation.current) throw new Error("请先确认正在上传的图片结果。");
    const file = files[0]!, previous = replacementOperation.current;
    if (previous && previous.api !== api) replacementOperation.current = null;
    else if (previous && (previous.itemId !== itemId || previous.file.name !== file.name || previous.file.size !== file.size || previous.file.lastModified !== file.lastModified)) {
      throw new Error("上一次替换结果尚未确认，请先为原图片重新选择同一文件，或在任务面板确认素材。");
    }
    const operation = replacementOperation.current ?? { api, itemId, file, mutationId: crypto.randomUUID() };
    replacementOperation.current = operation;
    uploadBusy.current = true; setUploading(true);
    try {
      setNotice("正在保存替换素材，原图片仍保留…");
      const task = await api.uploadFile(operation.file, operation.mutationId);
      const accept = (value: UploadTask) => { if (alive.current && apiRef.current === api) setUploads(current => mergeTask(current, value, item => item.taskId)); };
      accept(task);
      const result = await api.pollUpload(task, accept);
      if (!alive.current || apiRef.current !== api || !writableRef.current) throw new Error("页面状态已改变，替换素材仍保留在任务中，原图片未被覆盖。");
      if (result.status === "FAILED") { replacementOperation.current = null; throw new Error(result.error || "替换素材保存失败，原图片未修改。"); }
      if (result.status !== "SUCCEEDED" || !result.material) throw new Error("替换素材仍在处理中，请查看任务并确认后重试，原图片未修改。");
      const material = result.material; api.image(material);
      await new Promise<void>((resolve, reject) => {
        const image = new Image(), timer = setTimeout(() => { image.src = ""; reject(new Error("替换素材读取超时，原图片仍保留。")); }, 20000);
        image.onload = () => { clearTimeout(timer); image.naturalWidth === material.width && image.naturalHeight === material.height ? resolve() : reject(new Error("替换素材尺寸与结果不符。")); };
        image.onerror = () => { clearTimeout(timer); reject(new Error("替换素材暂时无法读取，原图片仍保留。")); }; image.src = material.url;
      });
      const current = docRef.current?.items.find(item => item.id === itemId);
      if (!alive.current || apiRef.current !== api || !writableRef.current || current?.kind !== "image" || current.locked || current.hidden
        || current.assetId !== target.assetId || current.assetSha256 !== target.assetSha256 || current.url !== target.url) {
        throw new Error("原图片或页面状态已改变，替换素材仍保留在任务中，请重新选择目标。");
      }
      replacementOperation.current = null; void refresh();
      return { url: material.url, assetId: material.assetId, assetSha256: material.assetSha256, versionId: undefined };
    } catch (error) {
      if (error instanceof NovartApiError && !error.uncertain) replacementOperation.current = null;
      if (alive.current && apiRef.current === api) setNotice(messageOf(error));
      throw error;
    } finally {
      if (apiRef.current === api) { uploadBusy.current = false; if (alive.current) setUploading(false); }
    }
  }

  async function submitGeneration() {
    const api = apiRef.current;
    if (!api || !writableRef.current || generationBusy.current || generationRecoveryBlocked) return;
    generationBusy.current = true; setSubmitting(true);
    try {
      if (!generationOperation.current) {
        if (!draft.ready || draft.blocked) throw new Error("请先完成需求恢复或处理草稿冲突。");
        const savedDraft = await draft.flush();
        if (!alive.current || apiRef.current !== api) return;
        if (!savedDraft.prompt.trim() || savedDraft.prompt.trim().length > 4000) throw new Error("请输入 1–4000 字的创作需求。");
        const saved = await save();
        if (!alive.current || apiRef.current !== api) return;
        if (!saved || savedSequence.current !== sequence.current || pendingSave.current) throw new Error("画布仍有修改待保存，请先完成保存。");
        const current = await workflowRef.current?.confirmForGeneration();
        if (!alive.current || apiRef.current !== api) return;
        if (!current) throw new Error("素材用途尚未恢复，请稍后继续。");
        const needsFrame = current.mode === "generate" && current.references.some(item => item.participates && item.purpose === "EXACT");
        if (needsFrame && (!savedDraft.outputFrameId || !docRef.current?.items.some(item => item.id === savedDraft.outputFrameId && item.kind === "frame"))) throw new Error("严格保留素材需要一个有效输出画框，请选择或创建后保存。");
        if (!writableRef.current || savedSequence.current !== sequence.current) throw new Error("画布已变化，请保存后重新提交。");
        if (!recoveryRef.current) throw new Error("浏览器暂不能保存创作确认记录，本次未提交。");
        const intent = recoveryRef.current.store({ mode: current.mode, input: { projectId, mutationId: crypto.randomUUID(), prompt: savedDraft.prompt.trim(), sizeSelection: { ratioKey: savedDraft.ratio, resolutionTier: savedDraft.quality }, workflowRevision: current.revision, documentRevision: saved.revision,
          ...(preparePsd && current.mode === "generate" ? psdLayerMode === "AUTO" ? { psdLayerMode: "AUTO" as const } : { psdLayerMode: "MANUAL" as const, psdLayerCount } : {}),
          ...(needsFrame ? { outputFrameId: savedDraft.outputFrameId } : {}) } });
        generationOperation.current = intent.input; generationMode.current = intent.mode;
        setPendingGeneration(true);
      }
      const operation = generationOperation.current;
      const result = await api.submitGeneration(operation);
      if (!alive.current || apiRef.current !== api) return;
      if (result.mode !== generationMode.current) throw new NovartApiError("任务类型与本次创作方式不一致，请刷新已有任务确认，原请求仍保留。", null, "INVALID_RECEIPT", true);
      clearGenerationIntent();
      if (!alive.current) return;
      setGenerations(current => mergeTask(current, result, value => value.requestId));
      generationPoll.resume(); setPollPaused(false); setPanel("tasks");
      setNotice(result.mode === "modify" ? "整图修改已提交，原图保留。新结果完成后会自动加入画布。" : "任务已提交，完成后图片会自动加入画布。");
    } catch (error) {
      if (apiRef.current !== api) return;
      if (error instanceof OwnedGenerationRecoveryError) setGenerationRecoveryBlocked(true);
      if (error instanceof NovartApiError && !error.uncertain) {
        try { clearGenerationIntent(); } catch (problem) { setNotice(messageOf(problem)); return; }
      }
      if (alive.current) setNotice(messageOf(error));
    } finally { if (apiRef.current === api) { generationBusy.current = false; if (alive.current) setSubmitting(false); } }
  }

  function changeWorkflow(update: (value: WorkflowInput) => WorkflowInput) {
    try { if (generationBusy.current || generationOperation.current) throw new Error("请先检查上次生成的结果。"); workflowRef.current?.change(update); }
    catch (error) { setNotice(messageOf(error)); }
  }
  async function refreshWorkflow() {
    try {
      if (writableRef.current && (sequence.current !== savedSequence.current || pendingSave.current)) await save();
      if (sequence.current !== savedSequence.current || pendingSave.current) throw new Error("画布尚未保存，请先确认保存后再读取可选素材。");
      await workflowRef.current?.load();
    } catch (error) { setNotice(messageOf(error)); }
  }
  function createOutputFrame() {
    const current = docRef.current;
    if (!current || !writableRef.current || pendingGeneration || generationBusy.current || !draft.ready || draft.blocked) return;
    const refs = workflowRef.current?.snapshot().draft?.references.filter(ref => ref.participates && ref.purpose === "EXACT") ?? [];
    const images = current.items.filter(item => refs.some(ref => ref.shapeId === item.id));
    const bounds = images.length ? getOwnedBounds(current, { itemIds: images.map(item => item.id) }) : { x: 0, y: 0, w: 640, h: 480 };
    const size = resolveGenerationSize(conversationRef.current?.sizeSelection() ?? { ratioKey: ratio, resolutionTier: quality }), scale = Math.max(0.5, (bounds.w + 80) / size.width, (bounds.h + 80) / size.height);
    const w = size.width * scale, h = size.height * scale, id = "shape:" + crypto.randomUUID();
    changeDocument({ ...current, items: [{ id, kind: "frame", x: bounds.x + bounds.w / 2 - w / 2, y: bounds.y + bounds.h / 2 - h / 2, w, h, rotation: 0, opacity: 1, parentId: current.pageId, text: "输出画框", fill: "#ffffff" }, ...current.items] });
    setOutputFrameId(id); setNotice("已按当前输出比例创建新画框，原画框和图片保持不变。保存后可提交严格保留创作。");
  }

  async function exportDocument(format: "png" | "svg" | "json", scope: Pick<OwnedExportOptions, "itemIds" | "frameId"> = {}) {
    const current = docRef.current;
    if (!current || current.warnings.length) { const error = new Error("旧内容尚未完整兼容，已停止导出以免遗漏。"); setNotice(error.message); throw error; }
    try {
      const blob = format === "png" ? await exportOwnedPng(current, scope) : format === "svg" ? new Blob([await exportOwnedSvg(current, scope)], { type: "image/svg+xml" }) : new Blob([JSON.stringify(serializeOwnedDocument(current), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = window.document.createElement("a");
      link.href = url; link.download = "DeepFlare-" + projectId + (scope.frameId ? "-frame" : scope.itemIds ? "-selection" : "") + "." + format; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNotice(scope.frameId ? "已导出选中画框。" : scope.itemIds ? "已导出选中内容。" : "已导出当前画布。");
    } catch (error) { setNotice(messageOf(error)); throw error; }
  }

  async function back() {
    try {
      if (draft.dirty || draft.ready && !draft.blocked) await draft.flush();
      await conversationRef.current?.flush();
      if (workflowRef.current?.snapshot().dirty) await workflowRef.current.save();
      if (sequence.current !== savedSequence.current || pendingSave.current) {
        await save();
        if (sequence.current !== savedSequence.current || pendingSave.current) throw new Error("修改尚未保存，请先确认保存或导出当前内容。");
      }
      if (parent !== window) send("navigate", { route: "projects" });
      else location.assign("/studio?workspaceId=" + encodeURIComponent(workspaceId) + "#/projects");
    } catch (error) { setNotice(messageOf(error)); }
  }

  const saveLabel = saveState === "loading" ? "正在打开…" : saveState === "saving" ? "正在保存…" : saveState === "dirty" ? "有未保存修改" : saveState === "conflict" ? "保存冲突" : saveState === "error" ? "保存未确认" : view?.updatedAt ? "已保存 " + new Date(view.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "已打开";
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground" data-testid="owned-editor" data-save-state={saveState} data-document-revision={view?.revision}>
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-card px-2 sm:gap-3 sm:px-5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/deepflare-mark.svg" alt="DeepFlare · 曜影深蓝" className="h-6 w-6 shrink-0 object-contain sm:h-7 sm:w-7" />
      <button type="button" className={headerButton} onClick={() => void back()} aria-label="返回项目库">←<span className="hidden sm:inline"> 项目</span></button>
      <strong className="min-w-0 flex-1 truncate text-sm">{visibleName}</strong>
      <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground sm:max-w-none" title={saveLabel} role="status" data-testid="owned-save-status">{saveLabel}</span>
      {canEdit && <button type="button" className={headerButton} disabled={saveState === "saving" || saveState === "saved"} onClick={() => void save().catch(() => undefined)}>{saveState === "error" ? "确认保存" : "保存"}</button>}
      <button type="button" className={headerButton} onClick={() => setPanel(current => current ? null : "generate")} aria-expanded={!!panel}>创作</button>
      <button type="button" className={headerButton} onClick={() => setPanel("tasks")} aria-label="任务记录">任务{generations.some(activeGeneration) || uploads.some(task => ["PENDING", "RUNNING"].includes(task.status)) ? " ·" : ""}</button>
      <details className="relative"><summary className={headerButton + " cursor-pointer list-none"}>导出</summary><div className="absolute right-0 top-full z-30 flex gap-2 rounded-2xl border border-border bg-card p-3 shadow-lg">{(["png", "svg", "json"] as const).map(format => <button key={format} className={button} disabled={!document || !!document.warnings.length} onClick={() => void exportDocument(format).catch(() => undefined)}>{format.toUpperCase()}</button>)}</div></details>
    </header>
    {!!saveError && <div role="alert" className="border-b border-border bg-accent-soft px-4 py-2 text-xs">{saveError}{saveState === "conflict" && " 当前内容仍在本页，请先导出副本再重新打开。"}{!document && <button type="button" className="ml-3 underline" onClick={() => location.reload()}>重新打开</button>}</div>}
    {!!document?.warnings.length && <div role="alert" className="border-b border-border bg-accent-soft px-4 py-2 text-xs">原项目含暂不能可靠转换的对象，已启用只读保护，未覆盖原稿。{document.warnings.join("；")}</div>}
    {(readOnly || view?.readOnly) && <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">当前项目为只读，可查看与导出。</div>}
    <div className="relative flex min-h-0 flex-1">
      <main className="relative min-h-0 min-w-0 flex-1">
        {document ? <OwnedCanvas key={projectId} document={document} focusImageId={focusImageId} clipboardScope={`${userId}:${workspaceId}:${projectId}`} onChange={changeDocument} readOnly={!canEdit} onUploadFiles={uploadFiles} onOpenMaterials={() => setPanel("materials")} onReplaceImage={replaceImage} onExport={(format, scope) => exportDocument(format, scope)} onSelectionChange={setSelectedIds} onImageAction={(action, ids) => void imageAction(action, ids)} imageTools={imageTools} /> : <div className="grid h-full place-content-center text-sm text-muted-foreground">{saveError ? "画布未能打开，原数据没有被修改。" : "正在读取项目…"}</div>}
        {resizingImage && document && <OwnedImageResize document={document} item={resizingImage} readOnly={!canEdit} onClose={() => setResizingImage(null)} onStore={async (file, sourceShapeId) => { if (!writableRef.current || uploadOperation.current || uploadBusy.current) throw new Error("请先确认正在上传的图片。"); uploadOperation.current = { file, sourceShapeId, mutationId: crypto.randomUUID() }; setPendingUpload(true); const completed = await runUpload(); if (!completed) throw new Error("上传结果尚未确认，图片文件仍保留，请在任务中继续读取。"); }} />}
        {maskingImage && <OwnedImageMask key={maskingImage.item.id} source={maskingImage.material} name={`图片${maskingImage.item.imageNumber ?? ""}`} readOnly={!canEdit} onClose={() => setMaskingImage(null)} onSubmit={(mask, instruction) => submitImageTool("inpaint", maskingImage.item.id, mask, instruction)} />}
      </main>
      <aside aria-label="创作面板" hidden={!panel} className={(panel ? "flex " : "hidden ") + "absolute inset-y-0 right-0 z-20 w-[min(380px,92vw)] flex-col border-l border-border bg-card shadow-lg md:relative md:w-[360px] md:shrink-0 md:shadow-none"}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="text-sm font-semibold">项目对话</h2><button className="px-2 text-muted-foreground" aria-label="收起面板" onClick={() => setPanel(null)}>×</button></div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          {placementFailed && <p role="alert" className="text-xs">图片已生成，放入画布未完成。<button className="ml-2 underline" onClick={() => { failedPlacements.current.clear(); setPlacementFailed(false); setPlacementRetry(value => value + 1); }}>重试放入</button></p>}
          {(pendingGeneration || pendingUpload || pendingImageTool || generationRecoveryBlocked) && <button className="text-left text-xs underline" onClick={() => setPanel("tasks")}>有尚未确认的操作，检查原任务</button>}
          <div className="min-h-0 flex-1"><OwnedConversationPanel ref={conversationRef} workspaceId={workspaceId} projectId={projectId} userId={userId} readOnly={!canEdit || pendingGeneration || generationRecoveryBlocked || pendingImageTool} isImagePlaced={image => !!document?.items.some(item => item.assetId === image.assetId && item.assetSha256 === image.assetSha256)} api={apiRef.current} prepare={prepareConversation} onAddReference={() => setPanel("materials")} onAdvancedSettings={() => { setPanel("settings"); if (!workflowRef.current?.snapshot().dirty) void refreshWorkflow(); }} activity={layerTasks.map(task => <button key={task.requestId} className="flex w-full items-center justify-between rounded-2xl border border-border px-3 py-3 text-xs" onClick={() => setPanel("layers")}><span>图片分层 · {task.layerMode === "AUTO" ? "按内容" : `${task.layerCount} 层`}</span><span>{task.status === "SUCCEEDED" ? "查看图层" : task.status === "FAILED" ? "未完成 · 查看" : "处理中…"}</span></button>)} onNotice={setNotice} onGeneration={task => { setGenerations(current => mergeTask(current, task, value => value.requestId)); generationPoll.resume(); setPollPaused(false); }} onInsert={(image, sourceShapeId) => insertImage(image, undefined, undefined, sourceShapeId)} onInsertLayers={insertLayers} /></div>
        </div>
      </aside>
      {<div hidden={!panel || panel === "generate"} style={{ display: !panel || panel === "generate" ? "none" : "flex" }} className="absolute inset-0 z-40 items-center justify-center bg-foreground/15 p-3" onPointerDown={event => event.stopPropagation()}>
        <section ref={toolDialog} role="dialog" aria-modal="true" aria-label={panel === "layers" ? "图片分层" : panel === "materials" ? "品牌素材" : panel === "settings" ? "素材与画框" : "任务记录"} className="flex max-h-[90%] w-full max-w-md flex-col rounded-3xl border border-border bg-card shadow-lg">
          <header className="flex shrink-0 items-center justify-between border-b border-border p-4"><h2 className="text-sm font-semibold">{panel === "layers" ? "图片分层" : panel === "materials" ? "品牌素材" : panel === "settings" ? "素材与画框" : "任务记录"}</h2><button aria-label="关闭工具窗口" onClick={() => setPanel("generate")}>×</button></header>
          <div className="min-h-0 space-y-3 overflow-y-auto p-4">
            {!!notice && panel && panel !== "generate" && <p role="status" className="text-xs leading-6" data-testid="owned-notice">{notice}</p>}
            {<div hidden={panel !== "layers"}><OwnedLayerPanel key={projectId} api={apiRef.current} workspaceId={workspaceId} projectId={projectId} userId={userId} document={document} selectedIds={selectedIds} readOnly={!canEdit} onPrepare={prepareLayers} onPlace={insertLayers} onTasks={setLayerTasks} /></div>}
            <span className="sr-only" data-testid="owned-draft-status" data-draft-state={draft.state}>{draft.error || draft.state}</span>
            {draft.blocked && <p role="alert" className="text-xs">{draft.error || "旧需求正在恢复。"}<button className="ml-2 underline" disabled={!canEdit} onClick={() => void draft.retry().catch(error => setNotice(messageOf(error)))}>检查需求保存</button></p>}
            {panel === "settings" && <>
              <OwnedWorkflowPanel conversationOnly key={projectId} state={workflowState} document={document} selectedIds={selectedIds} readOnly={!canEdit} frozen={pendingGeneration || submitting || generationRecoveryBlocked || !draft.ready || draft.blocked} outputFrameId={outputFrameId} onOutputFrameChange={setOutputFrameId} onCreateOutputFrame={() => { try { createOutputFrame(); } catch (error) { setNotice(messageOf(error)); } }} onChange={changeWorkflow} onSave={() => void workflowRef.current?.save().catch(error => setNotice(messageOf(error)))} onRefresh={() => void refreshWorkflow()} onResolveConflict={choice => { try { workflowRef.current?.resolveConflict(choice); } catch (error) { setNotice(messageOf(error)); } }} />
              <button className={button} disabled={!canEdit} onClick={() => void applyWorkflowToConversation().catch(error => setNotice(messageOf(error)))}>应用到对话</button>
              {prompt && <details><summary className="text-xs">旧版未发送需求</summary><p className="whitespace-pre-wrap text-sm">{prompt}</p><button className={button} disabled={!canEdit} onClick={() => { try { conversationRef.current?.restoreText(prompt); setPanel("generate"); } catch (error) { setNotice(messageOf(error)); } }}>复制到对话</button></details>}
            </>}
            {panel === "materials" && <OwnedBrandMaterialsDrawer workspaceId={workspaceId} projectId={projectId} userId={userId} readOnly={!canEdit} onClose={() => setPanel("generate")} onInsert={material => insertImage(material)} onReference={material => { if (!conversationRef.current) throw new Error("对话尚未恢复。"); conversationRef.current.addReferences([{ referenceId: "brand:" + material.assetId, name: material.fileName, assetId: material.assetId, assetSha256: material.assetSha256, width: material.width, height: material.height, purpose: "REFERENCE" }]); setPanel("generate"); }} />}
                      {panel === "tasks" && <>
            {pendingImageTool && <button className={button} disabled={!canEdit || !imageToolOperation.current} onClick={() => { const input = imageToolOperation.current; if (input) void submitImageTool(input.operation, input.target.shapeId, input.mask, input.instruction).catch(() => undefined); }}>检查上次图片编辑</button>}
            <button className={button} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "正在读取…" : "刷新任务"}</button>
            {pendingUpload && <button className={button + " ml-2"} disabled={uploading || !canEdit} onClick={() => void runUpload()}>检查上次上传</button>}
            {pendingGeneration && <button className={button} disabled={submitting || !canEdit} onClick={() => void submitGeneration()}>检查上次生成</button>}
            {!uploads.length && !generations.length && <p className="py-8 text-center text-xs text-muted-foreground">上传和生成进度会显示在这里。</p>}
            {uploads.map(task => <section className="flex items-center gap-2 border-b border-border py-2" key={task.taskId} data-task-id={task.taskId}><h3 className="truncate text-xs font-semibold">{task.material?.fileName || "图片上传"}</h3><p className="text-xs text-muted-foreground">{task.status === "SUCCEEDED" ? "已存入素材库" : task.status === "FAILED" ? task.error : Date.now() > Date.parse(task.expiresAt) ? "处理时间较长，请刷新确认结果" : `保存中 · ${task.progress}%`}</p>{task.material && !document?.items.some(item => item.assetId === task.material!.assetId && item.assetSha256 === task.material!.assetSha256) && <button className={button} disabled={!canEdit} onClick={() => void insertImage(task.material!).catch(error => setNotice(messageOf(error)))}>加入画布</button>}</section>)}
            {generations.map(task => <OwnedGenerationCard compact isImagePlaced={image => !!document?.items.some(item => item.assetId === image.assetId && item.assetSha256 === image.assetSha256)} key={projectId + ":" + task.requestId} task={task} api={apiRef.current} canEdit={canEdit} onNotice={setNotice}
              onTask={updated => { setGenerations(current => mergeTask(current, updated, value => value.requestId)); generationPoll.resume(); setPollPaused(false); }}
              onInsert={image => insertImage(image, undefined, undefined, task.sourceShapeId)} onInsertLayers={insertLayers} />)}
          </>}
          </div>
        </section>
      </div>}
    </div>
    {notice && (!panel || panel === "generate") && <div role="status" data-testid="owned-notice" className="fixed bottom-20 left-4 z-30 flex max-w-[min(460px,80vw)] gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-xs shadow-lg"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
    <input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="选择图片" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void uploadFiles(files); }} />
  </div>;
}

export default OwnedEditorClient;
