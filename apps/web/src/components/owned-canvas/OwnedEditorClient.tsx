"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StudioMaterial, GenerationAspectRatioKey, resolveGenerationSize, type EditorDocumentView } from "@brandai/contracts";
import { NovartApiError } from "../../lib/novart-api-client";
import { decodeOwnedCanvas, encodeOwnedCanvas } from "../../lib/owned-canvas-codec";
import { serializeOwnedDocument, type OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import { exportOwnedPng, exportOwnedSvg, getOwnedBounds } from "../../lib/owned-canvas-export";
import { OwnedCanvas } from "./OwnedCanvas";
import { OwnedWorkflowPanel } from "./OwnedWorkflowPanel";
import { OwnedGenerationCard } from "./OwnedGenerationCard";
import { createOwnedWorkflowSession, type OwnedWorkflowSession, type WorkflowSessionState } from "./owned-workflow-session";
import { useOwnedDraft } from "./use-owned-draft";
import { createOwnedGenerationRecovery, OwnedGenerationRecoveryError } from "./owned-generation-recovery";
import { createOwnedEditorApi, type Material, type UploadTask, type GenerationTask, type PersistentImage, type GenerationInput, type WorkflowInput } from "./owned-editor-api";

type InitialTask = { kind: "STUDIO_UPLOAD" | "STUDIO_GENERATION"; id: string };
export type OwnedEditorClientProps = { workspaceId: string; projectId: string; userId: string; readOnly?: boolean; projectName?: string; initialTask?: InitialTask };
type ProductApi = ReturnType<typeof createOwnedEditorApi>;
type SaveState = "loading" | "saved" | "dirty" | "saving" | "error" | "conflict";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请稍后重试。";
const activeGeneration = (task: GenerationTask) => ["PENDING", "RUNNING"].includes(task.status) || task.status === "SUCCEEDED" && ["NOT_REQUESTED", "PENDING", "RUNNING"].includes(task.resultState);
const mergeTask = <T,>(items: T[], item: T, identity: (value: T) => string) => [item, ...items.filter(value => identity(value) !== identity(item))].slice(0, 50);
const button = "rounded-full border border-border bg-card px-3 py-2 text-xs text-fg hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

export function OwnedEditorClient({ workspaceId, projectId, userId, readOnly = false, projectName = "创作项目", initialTask }: OwnedEditorClientProps) {
  const [document, setDocument] = useState<OwnedCanvasDocument | null>(null);
  const [view, setView] = useState<EditorDocumentView | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [panel, setPanel] = useState<"generate" | "materials" | "tasks" | null>("generate");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [generations, setGenerations] = useState<GenerationTask[]>([]);
  const [workflowState, setWorkflowState] = useState<WorkflowSessionState | null>(null);
  const [outputFrameId, setOutputFrameId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<GenerationInput["sizeSelection"]["ratioKey"]>("1:1");
  const [quality, setQuality] = useState<"1K" | "2K">("1K");
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingGeneration, setPendingGeneration] = useState(false);
  const [generationRecoveryBlocked, setGenerationRecoveryBlocked] = useState(false);
  const [pendingUpload, setPendingUpload] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const apiRef = useRef<ProductApi | null>(null), alive = useRef(false), docRef = useRef<OwnedCanvasDocument | null>(null);
  const viewRef = useRef<EditorDocumentView | null>(null), writableRef = useRef(false), savedSequence = useRef(0), sequence = useRef(0);
  const saveBusy = useRef(false), saveBlocked = useRef(false), pendingSave = useRef<{ canvas: string; sequence: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null), uploadInput = useRef<HTMLInputElement>(null);
  const generationOperation = useRef<GenerationInput | null>(null), uploadOperation = useRef<{ file: File; mutationId: string; point?: { x: number; y: number } } | null>(null);
  const refreshBusy = useRef(false), generationBusy = useRef(false), uploadBusy = useRef(false), pollStarted = useRef(0);
  const handoffBusy = useRef(false);
  const workflowRef = useRef<OwnedWorkflowSession | null>(null), generationMode = useRef<"generate" | "modify" | null>(null), taskFocusBusy = useRef(false);
  const recoveryRef = useRef<ReturnType<typeof createOwnedGenerationRecovery> | null>(null);
  const canEdit = !!document && !readOnly && !view?.readOnly && !document.warnings.length && saveState !== "conflict";
  writableRef.current = canEdit;
  const workflow = workflowState?.draft;
  const draft = useOwnedDraft({ workspaceId, projectId, userId, value: { prompt, ratio, quality, ...(outputFrameId ? { outputFrameId } : {}) },
    onRestore: value => { setPrompt(value.prompt); setRatio(value.ratio); setQuality(value.quality); setOutputFrameId(value.outputFrameId ?? ""); },
    readOnly: readOnly || !!view?.readOnly || !!document?.warnings.length, frozen: pendingGeneration || submitting || generationRecoveryBlocked });

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

  const changeDocument = useCallback((next: OwnedCanvasDocument) => {
    if (!writableRef.current) return;
    docRef.current = next; sequence.current++; setDocument(next);
    if (!saveBusy.current && !pendingSave.current) setSaveState("dirty");
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    const api = apiRef.current;
    if (!api || refreshBusy.current) return;
    refreshBusy.current = true; if (!quiet) { setRefreshing(true); pollStarted.current = Date.now(); setPollPaused(false); }
    try {
      const values = await Promise.allSettled([api.listMaterials(), api.listUploads(), api.listGenerations()]);
      if (!alive.current || apiRef.current !== api) return;
      if (values[0].status === "fulfilled") setMaterials(values[0].value);
      if (values[1].status === "fulfilled") setUploads(values[1].value);
      if (values[2].status === "fulfilled") {
        setGenerations(values[2].value);
        const accepted = values[2].value.find(task => task.mutationId === generationOperation.current?.mutationId);
        if (accepted && accepted.mode === generationMode.current) {
          try { clearGenerationIntent(); } catch (error) { setNotice(messageOf(error)); }
        }
      }
      const failure = values.find(value => value.status === "rejected");
      if (failure?.status === "rejected") { setNotice(messageOf(failure.reason)); if (quiet) setPollPaused(true); }
    } finally { if (apiRef.current === api) { refreshBusy.current = false; if (alive.current) setRefreshing(false); } }
  }, [clearGenerationIntent]);

  const openExistingTask = useCallback(async (kind: InitialTask["kind"], id: string) => {
    const api = apiRef.current;
    if (!api || !docRef.current || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !["STUDIO_UPLOAD", "STUDIO_GENERATION"].includes(kind)) throw new Error("任务不属于当前画布或画布尚未就绪。");
    if (taskFocusBusy.current) throw new Error("正在读取上一条任务，请稍后重试。");
    taskFocusBusy.current = true;
    try {
      if (kind === "STUDIO_UPLOAD") { const task = await api.getUpload(id); if (!alive.current || apiRef.current !== api) return false; setUploads(current => mergeTask(current, task, value => value.taskId)); }
      else { const task = await api.getGeneration(id); if (!alive.current || apiRef.current !== api) return false; setGenerations(current => mergeTask(current, task, value => value.requestId)); }
      setPanel("tasks"); setNotice("已展开服务器中的任务记录，图片是否加入画布由你决定。"); return true;
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
    setSaveState("loading"); setSaveError(""); setDocument(null); setView(null); docRef.current = null; viewRef.current = null; sequence.current = 0; savedSequence.current = 0;
    pendingSave.current = null; saveBlocked.current = false;
    saveBusy.current = false; refreshBusy.current = false; uploadBusy.current = false; generationBusy.current = false; handoffBusy.current = false; taskFocusBusy.current = false;
    generationMode.current = null; setSelectedIds([]);
    uploadOperation.current = null; generationOperation.current = null; setPendingUpload(false); setPendingGeneration(false);
    recoveryRef.current = null; setGenerationRecoveryBlocked(false);
    try {
      const recovery = createOwnedGenerationRecovery({ workspaceId, projectId, userId }); recoveryRef.current = recovery;
      const pending = recovery.load();
      if (pending) {
        generationOperation.current = pending.input; generationMode.current = pending.mode; setPendingGeneration(true);
        setNotice("上一份创作的受理结果还未确认。原请求已保留，请查看任务或确认同一份回执；不会自动提交。");
      }
    } catch (error) { setGenerationRecoveryBlocked(true); setNotice(messageOf(error)); }
    void api.session.load().then(async result => {
      const loaded = await decodeOwnedCanvas(result.canvas);
      if (!alive.current || apiRef.current !== api) return;
      docRef.current = loaded; viewRef.current = result; setView(result); setDocument(loaded); setSaveState("saved");
      pollStarted.current = Date.now(); void refresh(); void workflowSession.load();
      if (initialTask) void openExistingTask(initialTask.kind, initialTask.id).catch(error => { if (alive.current && apiRef.current === api) setNotice(messageOf(error)); });
    }).catch(error => {
      if (!alive.current || apiRef.current !== api) return;
      setSaveError(messageOf(error)); setSaveState("error"); send("startup-error", { code: "OWNED_CANVAS_LOAD_FAILED" });
    });
    return () => { alive.current = false; workflowSession.dispose(); stopWorkflow(); controller.abort(); if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [workspaceId, projectId, userId, refresh, send, save, openExistingTask, initialTask?.kind, initialTask?.id]);

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
        && typeof data.taskId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.taskId) && ["STUDIO_UPLOAD", "STUDIO_GENERATION"].includes(data.kind)) {
        const api = apiRef.current;
        const reply = (ok: boolean, error?: string) => { if (alive.current && apiRef.current === api) parent.postMessage({ type: "novart-product-task-opened", workspaceId, userId, projectId, kind: data.kind, taskId: data.taskId, token: data.token, ok, ...(error ? { error } : {}) }, location.origin); };
        void openExistingTask(data.kind, data.taskId).then(opened => { if (opened) reply(true); }).catch(error => reply(false, messageOf(error))); return;
      }
      if (event.origin !== location.origin || event.source !== parent || !data || data.type !== "nv-studio" || data.projectId !== projectId) return;
      if (["insert-material", "confirm-save"].includes(data.action)) {
        if (typeof data.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.requestId)) return;
        const action = data.action === "insert-material" ? "insert-material-result" : "confirm-save-result";
        const api = apiRef.current;
        if (!api || handoffBusy.current) { send(action, { requestId: data.requestId, status: "failed", error: "正在确认上一份保存，请稍后继续。" }); return; }
        handoffBusy.current = true;
        void (async () => {
          try {
            if (!docRef.current) throw new Error("画布还没有恢复完成，请稍后再试。");
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
            const saved = await save();
            if (!alive.current || apiRef.current !== api) return;
            if (!saved || sequence.current !== savedSequence.current || pendingSave.current || saveBlocked.current) throw new Error("画布修改尚未确认保存，请稍后继续。");
            send(action, { requestId: data.requestId, status: "saved", revision: saved.revision });
          } catch (error) {
            if (alive.current && apiRef.current === api) send(action, { requestId: data.requestId, status: "failed", error: error instanceof Error && error.name === "ZodError" ? "素材回执格式无法确认，原文件保留。" : messageOf(error) });
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
  }, [workspaceId, userId, projectId, save, send, openExistingTask]);

  useEffect(() => {
    if (!generations.some(activeGeneration) || pollPaused) return;
    const timer = setTimeout(() => {
      if (Date.now() - pollStarted.current >= 360000) { setPollPaused(true); setNotice("自动读取已暂停，已受理的任务仍由服务器处理，可刷新任务确认最终结果。"); }
      else void refresh(true);
    }, 3500);
    return () => clearTimeout(timer);
  }, [generations, pollPaused, refresh]);

  async function insertImage(material: PersistentImage, point?: { x: number; y: number }, identity?: string) {
    if (!writableRef.current || !docRef.current || !apiRef.current) throw new Error("当前画布只读，无法加入图片。");
    const api = apiRef.current; api.image(material);
    await new Promise<void>((resolve, reject) => {
      const image = new Image(), timer = setTimeout(() => { image.src = ""; reject(new Error("图片读取超时，素材仍保留在库中，可再次加入。")); }, 20000);
      image.onload = () => { clearTimeout(timer); image.naturalWidth === material.width && image.naturalHeight === material.height ? resolve() : reject(new Error("图片尺寸与存储回执不一致，请刷新素材后重试。")); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("图片暂时无法读取，请检查存储后重试。")); }; image.src = material.url;
    });
    if (!alive.current || apiRef.current !== api) return;
    if (!writableRef.current || !docRef.current) throw new Error("画布已变为只读，素材仍保留，图片尚未加入。");
    const current = docRef.current, longest = Math.max(material.width, material.height), scale = Math.min(900 / longest, Math.max(1, 100 / longest));
    const w = material.width * scale, h = material.height * scale;
    const center = point ?? { x: (360 - current.camera.x) / current.camera.zoom, y: (260 - current.camera.y) / current.camera.zoom };
    changeDocument({ ...current, items: [...current.items, { id: identity ?? "shape:" + crypto.randomUUID(), kind: "image", x: center.x - w / 2, y: center.y - h / 2, w, h, rotation: 0, opacity: 1, parentId: current.pageId, url: material.url, assetId: material.assetId, assetSha256: material.assetSha256, ...(material.versionId ? { versionId: material.versionId } : {}) }] });
    setNotice("图片已加入画布，保存状态见顶部。");
  }

  async function runUpload() {
    const api = apiRef.current, operation = uploadOperation.current;
    if (!api || !operation || uploadBusy.current || !writableRef.current) return;
    uploadBusy.current = true; setUploading(true); setPanel("tasks");
    try {
      setNotice("正在提交图片…");
      const task = await api.uploadFile(operation.file, operation.mutationId);
      if (!alive.current || apiRef.current !== api) return;
      uploadOperation.current = null; setPendingUpload(false);
      const accept = (value: UploadTask) => { if (alive.current && apiRef.current === api) setUploads(current => mergeTask(current, value, item => item.taskId)); };
      accept(task); setNotice("图片已受理，关闭页面后仍会继续保存。");
      const result = await api.pollUpload(task, accept);
      if (!alive.current || apiRef.current !== api) return;
      if (result.status === "FAILED") throw new Error(result.error || "图片保存失败，请重新选择。");
      if (result.status === "SUCCEEDED" && result.material) { await insertImage(result.material, operation.point); void refresh(); }
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
      pollStarted.current = Date.now(); setPollPaused(false); setPanel("tasks");
      setNotice(result.mode === "modify" ? "整图修改已受理，原图保留。新结果存入素材库后，可手动加入画布。" : "任务已受理，完成并存入素材库后，可手动加入画布。");
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
    try { if (generationBusy.current || generationOperation.current) throw new Error("请先确认上一份创作回执。"); workflowRef.current?.change(update); }
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
    const bounds = images.length ? getOwnedBounds({ ...current, items: images }) : { x: 0, y: 0, w: 640, h: 480 };
    const size = resolveGenerationSize({ ratioKey: ratio, resolutionTier: quality }), scale = Math.max(0.5, (bounds.w + 80) / size.width, (bounds.h + 80) / size.height);
    const w = size.width * scale, h = size.height * scale, id = "shape:" + crypto.randomUUID();
    changeDocument({ ...current, items: [{ id, kind: "frame", x: bounds.x + bounds.w / 2 - w / 2, y: bounds.y + bounds.h / 2 - h / 2, w, h, rotation: 0, opacity: 1, parentId: current.pageId, text: "输出画框", fill: "#ffffff" }, ...current.items] });
    setOutputFrameId(id); setNotice("已按当前输出比例创建新画框，原画框和图片保持不变。保存后可提交严格保留创作。");
  }

  async function exportDocument(format: "png" | "svg" | "json") {
    const current = docRef.current;
    if (!current || current.warnings.length) { const error = new Error("旧内容尚未完整兼容，已停止导出以免遗漏。"); setNotice(error.message); throw error; }
    try {
      const blob = format === "png" ? await exportOwnedPng(current) : format === "svg" ? new Blob([await exportOwnedSvg(current)], { type: "image/svg+xml" }) : new Blob([JSON.stringify(serializeOwnedDocument(current), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = window.document.createElement("a");
      link.href = url; link.download = "Novart-" + projectId + "." + format; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNotice("已导出当前画布。");
    } catch (error) { setNotice(messageOf(error)); throw error; }
  }

  async function back() {
    try {
      if (draft.dirty || draft.ready && !draft.blocked) await draft.flush();
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
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-fg" data-testid="owned-editor" data-save-state={saveState} data-document-revision={view?.revision}>
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-3 sm:px-5">
      <button type="button" className={button} onClick={() => void back()} aria-label="返回项目库">← 项目</button>
      <strong className="min-w-0 flex-1 truncate text-sm">{projectName}</strong>
      <span className="text-xs text-muted-fg" role="status" data-testid="owned-save-status">{saveLabel}</span>
      {canEdit && <button type="button" className={button} disabled={saveState === "saving" || saveState === "saved"} onClick={() => void save().catch(() => undefined)}>{saveState === "error" ? "确认保存" : "保存"}</button>}
      <button type="button" className={button} onClick={() => setPanel(current => current ? null : "generate")} aria-expanded={!!panel}>创作</button>
    </header>
    {!!saveError && <div role="alert" className="border-b border-border bg-accent-soft px-4 py-2 text-xs">{saveError}{saveState === "conflict" && " 当前内容仍在本页，请先导出副本再重新打开。"}{!document && <button type="button" className="ml-3 underline" onClick={() => location.reload()}>重新打开</button>}</div>}
    {!!document?.warnings.length && <div role="alert" className="border-b border-border bg-accent-soft px-4 py-2 text-xs">原项目含暂不能可靠转换的对象，已启用只读保护，未覆盖原稿。{document.warnings.join("；")}</div>}
    {(readOnly || view?.readOnly) && <div className="border-b border-border px-4 py-2 text-xs text-muted-fg">当前项目为只读，可查看与导出。</div>}
    <div className="relative flex min-h-0 flex-1">
      <main className="relative min-h-0 min-w-0 flex-1">
        {document ? <OwnedCanvas key={projectId} document={document} onChange={changeDocument} readOnly={!canEdit} onUploadFiles={uploadFiles} onExport={format => exportDocument(format)} onSelectionChange={setSelectedIds} /> : <div className="grid h-full place-content-center text-sm text-muted-fg">{saveError ? "画布未能打开，原数据没有被修改。" : "正在读取项目…"}</div>}
      </main>
      {panel && <aside aria-label="创作面板" className="absolute inset-y-0 right-0 z-20 flex w-[min(340px,92vw)] flex-col border-l border-border bg-card shadow-lg sm:relative sm:w-80 sm:shrink-0 sm:shadow-none">
        <div className="flex gap-1 border-b border-border p-3">{([['generate', '生成'], ['materials', '素材'], ['tasks', '任务']] as const).map(([id, label]) => <button key={id} type="button" className={button + (panel === id ? " !border-primary !bg-accent-soft !text-primary" : "")} onClick={() => setPanel(id)}>{label}</button>)}<button className="ml-auto px-2 text-muted-fg" aria-label="收起面板" onClick={() => setPanel(null)}>×</button></div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {!!notice && <p role="status" className="rounded-xl bg-accent-soft p-3 text-xs leading-6" data-testid="owned-notice">{notice}</p>}
          {panel === "generate" && <>
            <div><h2 className="text-sm font-semibold">{workflow?.mode === "modify" ? "修改整张图片" : "生成新图片"}</h2><p className="mt-1 text-xs leading-5 text-muted-fg">描述想法，结果单独保留，由你决定是否加入画布。</p></div>
            <textarea aria-label="创作需求" className="min-h-40 w-full resize-y rounded-2xl border border-border bg-bg p-3 text-sm outline-none focus:border-primary" placeholder="想创作什么？" maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)} onCompositionStart={draft.compositionStart} onCompositionEnd={draft.compositionEnd} disabled={!canEdit || pendingGeneration || submitting || generationRecoveryBlocked || !draft.ready || draft.blocked} />
            <div className="flex gap-2"><select aria-label="图片比例" className={button} value={ratio} disabled={!canEdit || pendingGeneration || submitting || generationRecoveryBlocked || !draft.ready || draft.blocked} onChange={event => setRatio(event.target.value as typeof ratio)}>{GenerationAspectRatioKey.options.filter(value => value !== "custom").map(value => <option key={value}>{value}</option>)}</select><select aria-label="图片画质" className={button} value={quality} disabled={!canEdit || pendingGeneration || submitting || generationRecoveryBlocked || !draft.ready || draft.blocked} onChange={event => setQuality(event.target.value as typeof quality)}><option>1K</option><option>2K</option></select></div>
            <div className="text-xs text-muted-fg" data-testid="owned-draft-status" data-draft-state={draft.state}>{draft.error || (draft.state === "saved" ? "需求已保存" : draft.state === "saving" ? "正在保存需求…" : draft.dirty ? "需求有待保存修改" : "正在恢复需求…")}{["error", "loading"].includes(draft.state) && <button type="button" className="ml-2 underline" onClick={() => void draft.retry().catch(error => setNotice(messageOf(error)))}>重新确认需求</button>}</div>
            <OwnedWorkflowPanel key={projectId} state={workflowState} document={document} selectedIds={selectedIds} readOnly={!canEdit} frozen={pendingGeneration || submitting || generationRecoveryBlocked || !draft.ready || draft.blocked} outputFrameId={outputFrameId} onOutputFrameChange={setOutputFrameId} onCreateOutputFrame={createOutputFrame} onChange={changeWorkflow} onSave={() => void workflowRef.current?.save().catch(error => setNotice(messageOf(error)))} onRefresh={() => void refreshWorkflow()} onResolveConflict={choice => { try { workflowRef.current?.resolveConflict(choice); } catch (error) { setNotice(messageOf(error)); } }} />
            <button type="button" className="w-full rounded-full bg-primary py-3 text-sm text-primary-fg disabled:opacity-40" disabled={!canEdit || submitting || generationRecoveryBlocked || !workflow || !pendingGeneration && (!prompt.trim() || !draft.ready || draft.blocked || !!workflowState?.dirty || !!workflowState?.busy || workflowState?.status !== "ready" || workflow.mode === "generate" && workflow.references.some(value => value.participates && value.purpose === "EXACT") && !outputFrameId)} onClick={() => void submitGeneration()}>{submitting ? "正在确认受理…" : pendingGeneration ? "确认上一份生成回执" : workflow?.mode === "modify" ? "提交整图修改" : "生成图片"}</button>
            <p className="text-xs text-muted-fg">品牌规则和素材权限由服务器核验；配置缺失或布局不支持时会说明原因。</p>
          </>}
          {panel === "materials" && <>
            <div className="flex gap-2"><button className={button} disabled={!canEdit || uploading || pendingUpload} onClick={() => uploadInput.current?.click()}>上传图片</button><button className={button} disabled={refreshing} onClick={() => void refresh()}>刷新素材</button></div>
            {!materials.length && <p className="py-8 text-center text-xs text-muted-fg">上传后的图片会保留在这里。</p>}
            <div className="grid grid-cols-2 gap-3">{materials.map(value => <div key={value.assetId} className="overflow-hidden rounded-2xl border border-border p-2"><img src={value.url} alt={value.fileName} className="aspect-square w-full rounded-xl object-contain" loading="lazy" /><p className="my-2 truncate text-xs">{value.fileName}</p><button className={button + " w-full"} disabled={!canEdit} onClick={() => void insertImage(value).catch(error => setNotice(messageOf(error)))}>加入画布</button></div>)}</div>
          </>}
          {panel === "tasks" && <>
            <button className={button} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "正在读取…" : "刷新任务"}</button>
            {pendingUpload && <button className={button + " ml-2"} disabled={uploading || !canEdit} onClick={() => void runUpload()}>确认上传回执</button>}
            {pendingGeneration && <button className={button} disabled={submitting || !canEdit} onClick={() => void submitGeneration()}>确认生成回执</button>}
            {!uploads.length && !generations.length && <p className="py-8 text-center text-xs text-muted-fg">上传和生成进度会显示在这里。</p>}
            {uploads.map(task => <section className="space-y-2 rounded-2xl border border-border p-3" key={task.taskId} data-task-id={task.taskId}><h3 className="truncate text-xs font-semibold">{task.material?.fileName || "图片上传"}</h3><p className="text-xs text-muted-fg">{task.status === "SUCCEEDED" ? "已存入素材库" : task.status === "FAILED" ? task.error : Date.now() > Date.parse(task.expiresAt) ? "处理时间较长，请刷新确认结果" : `保存中 · ${task.progress}%`}</p>{task.material && <button className={button} disabled={!canEdit} onClick={() => void insertImage(task.material!).catch(error => setNotice(messageOf(error)))}>加入画布</button>}</section>)}
            {generations.map(task => <OwnedGenerationCard key={projectId + ":" + task.requestId} task={task} api={apiRef.current} canEdit={canEdit} onNotice={setNotice}
              onTask={updated => { setGenerations(current => mergeTask(current, updated, value => value.requestId)); pollStarted.current = Date.now(); setPollPaused(false); }}
              onInsert={image => insertImage(image)} />)}
          </>}
        </div>
        <div className="flex items-center gap-2 border-t border-border p-3"><span className="mr-auto text-xs text-muted-fg">导出</span>{(["png", "svg", "json"] as const).map(format => <button key={format} className={button} disabled={!document || !!document.warnings.length} onClick={() => void exportDocument(format).catch(() => undefined)}>{format.toUpperCase()}</button>)}</div>
      </aside>}
    </div>
    <input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="选择图片" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void uploadFiles(files); }} />
  </div>;
}

export default OwnedEditorClient;
