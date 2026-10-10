import { z } from "zod";
import { GenerationAspectRatioKey, GenerationResolutionTier, StudioWorkflowTarget, WorkbenchDraftSaveInput, WorkbenchDraftView } from "@brandai/contracts";
import { NovartApiError } from "../../lib/novart-api-client";

const OwnedDraftValueSchema = z.object({
  prompt: z.string().max(4000), ratio: GenerationAspectRatioKey,
  quality: GenerationResolutionTier, outputFrameId: StudioWorkflowTarget.shape.shapeId.optional(),
}).strict().refine(value => value.ratio !== "custom", "自定义比例的完整尺寸尚不能在此输入框恢复，原稿已保留。");
export type OwnedDraftValue = z.infer<typeof OwnedDraftValueSchema>;
type Form = NonNullable<WorkbenchDraftView["inputForm"]>;
type SaveInput = z.infer<typeof WorkbenchDraftSaveInput>;
export const emptyOwnedDraft = (): OwnedDraftValue => ({ prompt: "", ratio: "1:1", quality: "1K" });
const problem = (message: string, code = "DRAFT_UNSUPPORTED") => new NovartApiError(message, 422, code);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The existing wire contract owns text and passes native fields through. Never
 * flatten mentions, media or rich nodes into a different generation request. */
export function decodeOwnedDraft(view: WorkbenchDraftView): OwnedDraftValue {
  if (view.referenceIssues.length) throw problem("原需求含尚未恢复的素材引用，已保护原稿，请先处理引用。");
  const form = view.inputForm;
  if (!form) return emptyOwnedDraft();
  for (const key of ["paramList", "mentionPreviewList"]) {
    if (form[key] != null && (!Array.isArray(form[key]) || form[key].length)) throw problem("原需求含引用内容，当前输入框暂不能完整恢复，原稿未被修改。");
  }
  if (form.lexicalJSONState != null) {
    const lexical = form.lexicalJSONState;
    if (!object(lexical) || !object(lexical.root) || lexical.root.type !== "root" || !Array.isArray(lexical.root.children)) throw problem("原需求的文字结构无法核对，原稿未被修改。");
    const paragraphs: string[] = [];
    for (const paragraph of lexical.root.children) {
      if (!object(paragraph) || paragraph.type !== "paragraph" || !Array.isArray(paragraph.children) || paragraph.indent || paragraph.format) throw problem("原需求含暂不支持的富文本，已保护原稿。");
      let text = "";
      for (const node of paragraph.children) {
        if (!object(node) || node.type !== "text" && node.type !== "linebreak" || node.format && node.format !== 0 || node.style || node.data || node.mode && node.mode !== "normal") throw problem("原需求含暂不支持的引用或富文本，已保护原稿。");
        if (node.type === "linebreak") text += "\n";
        else if (typeof node.text === "string") text += node.text;
        else throw problem("原需求的文字结构无法核对，原稿未被修改。");
      }
      paragraphs.push(text);
    }
    if (paragraphs.join("\n") !== form.text) throw problem("原需求正文和文字节点不一致，已保护原稿，请先核对内容。");
  }
  const selection = form.sizeSelection;
  if (selection != null && (!object(selection) || selection.customRatio != null || Object.keys(selection).some(key => !["ratioKey", "resolutionTier"].includes(key)))) throw problem("原需求的图片尺寸暂不能完整恢复，原稿未被修改。");
  const parsed = OwnedDraftValueSchema.safeParse({ prompt: form.text, ratio: object(selection) ? selection.ratioKey : form.ratio ?? "1:1", quality: object(selection) ? selection.resolutionTier : form.quality ?? "1K", ...(form.outputFrameId ? { outputFrameId: form.outputFrameId } : {}) });
  if (!parsed.success) throw problem("原需求的文字或图片选项暂不能完整恢复，原稿未被修改。");
  return parsed.data;
}

export function encodeOwnedDraft(base: Form | null, value: OwnedDraftValue): Form {
  const parsed = OwnedDraftValueSchema.safeParse(value);
  if (!parsed.success) throw problem("请输入 4000 字以内的需求，并选择有效图片比例与画质。", "DRAFT_INVALID_INPUT");
  if (base) decodeOwnedDraft({ projectId: "validation", revision: 0, inputForm: base, updatedAt: null, referenceIssues: [] });
  const text = value.prompt;
  // A plain native lexical tree and text always describe the same content.
  // Other compatible form preferences are retained, never spread into refs.
  const result: Form = { ...base, text, sizeSelection: { ratioKey: value.ratio, resolutionTier: value.quality },
    paramList: [], mentionPreviewList: [], lexicalJSONState: { root: { type: "root", version: 1, direction: null, format: "", indent: 0,
      children: text.split("\n").map(line => ({ type: "paragraph", version: 1, direction: null, format: "", indent: 0, children: line ? [{ type: "text", version: 1, text: line, detail: 0, format: 0, mode: "normal", style: "" }] : [] })) } } };
  if (base && "ratio" in base) result.ratio = value.ratio;
  if (base && "quality" in base) result.quality = value.quality;
  if (value.outputFrameId) result.outputFrameId = value.outputFrameId; else delete result.outputFrameId;
  return result;
}

export function createOwnedDraftApi(workspaceId: string, projectId: string, userId: string, options: { fetcher?: typeof fetch; origin?: string } = {}) {
  const fetcher = options.fetcher ?? fetch, origin = options.origin ?? window.location.origin;
  const path = "/studio/draft?" + new URLSearchParams({ workspaceId, projectId });
  async function request(input?: SaveInput, keepalive = false): Promise<WorkbenchDraftView> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    const body = input ? JSON.stringify(WorkbenchDraftSaveInput.parse(input)) : undefined;
    // Browser keepalive has a shared 64 KiB budget. Never claim an oversized
    // close-time request was sent; the beforeunload guard keeps it reviewable.
    if (keepalive && body && new TextEncoder().encode(body).length > 60000) { clearTimeout(timer); throw problem("需求较长，请等待保存完成后再关闭页面。", "DRAFT_CLOSE_SIZE"); }
    try {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw problem("草稿地址不属于当前工作台。");
      const response = await fetcher(url.pathname + url.search, { method: input ? "POST" : "GET", headers: { "X-Novart-User": userId, ...(input ? { "Content-Type": "application/json" } : {}) }, body,
        signal: controller.signal, credentials: "same-origin", cache: "no-store", keepalive });
      const raw = await response.json().catch(() => { throw new NovartApiError("草稿回执无法读取，请保留本页并确认保存。", controller.signal.aborted ? null : response.status, "DRAFT_RECEIPT", !!input); });
      if (!response.ok) throw new NovartApiError(response.status === 409 ? "另一页面已修改这份需求。当前输入仍保留，请先复制内容再重新打开。" : typeof raw?.error === "string" ? raw.error : "需求暂未保存，请保留本页后重试。", response.status, raw?.code, !!input && response.status >= 500);
      const parsed = WorkbenchDraftView.safeParse(raw);
      if (!parsed.success || parsed.data.projectId !== projectId) throw new NovartApiError("草稿回执与当前项目不一致，原输入仍保留。", 422, "DRAFT_RECEIPT", !!input);
      return parsed.data;
    } catch (error) {
      if (error instanceof NovartApiError) throw error;
      throw new NovartApiError(controller.signal.aborted ? "需求保存确认超时，请保留本页并重试确认。" : "连接中断，请保留当前输入并重试确认。", null, undefined, !!input);
    } finally { clearTimeout(timer); }
  }
  return { read: () => request(), write: (input: SaveInput, keepalive = false) => request(input, keepalive) };
}

export type OwnedDraftState = "loading" | "saved" | "dirty" | "saving" | "error" | "conflict" | "unsupported";
export type OwnedDraftSnapshot = { state: OwnedDraftState; error: string; ready: boolean; dirty: boolean; blocked: boolean; revision: number | null; value: OwnedDraftValue };
type DraftTransport = ReturnType<typeof createOwnedDraftApi>;
/** Revision-CAS saves have no mutation id. A lost response is reconciled by a
 * checked GET; only the exact next revision and whole form confirm our write. */
export function createOwnedDraftSession(api: DraftTransport, projectId: string, notify: (value: OwnedDraftSnapshot) => void = () => {}) {
  let current: WorkbenchDraftView | null = null, desired = emptyOwnedDraft(), confirmed = emptyOwnedDraft();
  let pending: { input: SaveInput; value: OwnedDraftValue } | null = null, running: Promise<OwnedDraftValue> | null = null, reading: Promise<OwnedDraftValue> | null = null;
  let state: OwnedDraftState = "loading", error = "", loaded = false;
  const snapshot = (): OwnedDraftSnapshot => ({ state, error, ready: loaded, dirty: !!pending || loaded && !same(desired, confirmed), blocked: !loaded || ["conflict", "unsupported"].includes(state), revision: current?.revision ?? null, value: { ...desired } });
  const publish = () => notify(snapshot());
  const fail = (problem: unknown) => { error = problem instanceof Error ? problem.message : "需求暂未保存，请保留本页。"; state = problem instanceof NovartApiError && problem.status === 409 ? "conflict" : problem instanceof NovartApiError && problem.code === "DRAFT_UNSUPPORTED" ? "unsupported" : "error"; publish(); };
  function accepted(view: WorkbenchDraftView, operation: NonNullable<typeof pending>) {
    if (view.projectId !== projectId || view.revision !== operation.input.revision + 1 || view.referenceIssues.length || !same(view.inputForm, operation.input.inputForm)) throw new NovartApiError("保存回执尚未核对，请保留本页后重试确认。", null, "DRAFT_RECEIPT", true);
    decodeOwnedDraft(view); current = view; confirmed = operation.value; pending = null;
  }
  function load(): Promise<OwnedDraftValue> {
    if (reading) return reading;
    if (running || pending || snapshot().dirty) return Promise.reject(new NovartApiError("当前输入尚未保存，不能重新读取并替换。", 409));
    loaded = false; state = "loading"; error = ""; publish();
    reading = (async () => {
      try { const view = await api.read(); if (view.projectId !== projectId) throw problem("草稿不属于当前项目。"); const value = decodeOwnedDraft(view); current = view; desired = value; confirmed = value; loaded = true; state = "saved"; publish(); return { ...value }; }
      catch (problem) { fail(problem); throw problem; }
    })().finally(() => { reading = null; });
    return reading;
  }
  function edit(value: OwnedDraftValue) {
    if (!loaded || state === "unsupported") return;
    desired = { ...value };
    if (!running && !["conflict", "error"].includes(state)) { state = same(desired, confirmed) && !pending ? "saved" : "dirty"; error = ""; }
    publish();
  }
  function flush(keepalive = false): Promise<OwnedDraftValue> {
    if (running) return running;
    if (!loaded || !current || ["conflict", "unsupported"].includes(state)) return Promise.reject(new NovartApiError(error || "需求还未恢复，请稍后再试。", 409));
    const work = async () => {
      state = "saving"; error = ""; publish();
      try {
        if (pending) {
          const remote = await api.read();
          if (remote.revision === pending.input.revision + 1 && same(remote.inputForm, pending.input.inputForm)) accepted(remote, pending);
          else if (remote.projectId !== projectId || remote.referenceIssues.length || remote.revision !== current!.revision || !same(remote.inputForm, current!.inputForm)) throw new NovartApiError("另一页面已修改这份需求。当前输入仍保留，请先复制内容再重新打开。", 409);
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!pending && same(desired, confirmed)) { state = "saved"; publish(); return { ...confirmed }; }
          pending ??= { input: { projectId, revision: current!.revision, inputForm: encodeOwnedDraft(current!.inputForm, desired) }, value: { ...desired } };
          const operation = pending;
          try { accepted(await api.write(operation.input, keepalive), operation); }
          catch (problem) { if (problem instanceof NovartApiError && !problem.uncertain) pending = null; throw problem; }
        }
        throw new NovartApiError("输入仍在变化，请停顿片刻后确认保存。", null);
      } catch (problem) { fail(problem); throw problem; }
    };
    running = work().finally(() => { running = null; }); return running;
  }
  return { snapshot, load, edit, flush };
}
