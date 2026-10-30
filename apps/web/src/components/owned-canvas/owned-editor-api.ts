import { z } from "zod";
import { StudioGenerationInput, StudioGenerationView, StudioGenerationComplianceView, StudioMaterial, StudioMaterialUploadView, StudioWorkflowView, StudioWorkflowAssets, StudioWorkflowSaveInput, StudioGeneratedPsdView } from "@brandai/contracts";
import { createDocumentSession, createNovartApiClient, NovartApiError } from "../../lib/novart-api-client";
import { StudioDecompositionInput, StudioDecompositionView } from "../../../../../packages/contracts/src/studio-decomposition";
import { matchesOwnedDecomposition, matchesOwnedPsdSelection } from "./owned-layer-options";
import { StudioImageToolCapabilities, StudioImageToolInput } from "@brandai/contracts";
import { StudioProjectContextSaveInput, StudioProjectContextView } from "@brandai/contracts";

export type Material = z.infer<typeof StudioMaterial>;
export type UploadTask = z.infer<typeof StudioMaterialUploadView>;
export type GenerationTask = z.infer<typeof StudioGenerationView>;
export type GenerationCompliance = z.infer<typeof StudioGenerationComplianceView>;
export type Workflow = z.infer<typeof StudioWorkflowView>;
export type WorkflowAssets = z.infer<typeof StudioWorkflowAssets>;
export type WorkflowInput = z.infer<typeof StudioWorkflowSaveInput>;
export type ProjectContext = z.infer<typeof StudioProjectContextView>;
export type ProjectContextInput = z.infer<typeof StudioProjectContextSaveInput>;
export type GenerationInput = z.infer<typeof StudioGenerationInput>;
export type PersistentImage = Pick<Material, "assetId" | "assetSha256" | "width" | "height" | "url"> & { versionId?: string; fileName?: string };
export type DecompositionTask = z.infer<typeof StudioDecompositionView>;
export type DecompositionInput = z.infer<typeof StudioDecompositionInput>;
export type GeneratedPsdTask = z.infer<typeof StudioGeneratedPsdView>;

/** Every request remains pinned to the authenticated page's brand and user.
 * X-Novart-User is an identity-consistency hint; the server still authenticates
 * the cookie and checks membership. No vendor token or browser storage is used. */
export function createOwnedEditorApi(workspaceId: string, projectId: string, userId: string, options: {
  fetcher?: typeof fetch; origin?: string; signal?: AbortSignal;
} = {}) {
  const fetcher = options.fetcher ?? fetch;
  const origin = options.origin ?? window.location.origin;
  const scopedFetch: typeof fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), origin);
    if (url.origin !== origin) throw new NovartApiError("请求地址不属于当前工作台。", 400);
    url.searchParams.set("workspaceId", workspaceId);
    const headers = new Headers(init.headers ?? request?.headers);
    headers.set("X-Novart-User", userId);
    const signals = [init.signal, options.signal].filter((value): value is AbortSignal => !!value);
    // Keep cancellation alive through response body decoding, not only until
    // fetch resolves its headers. A body that stalls must still hit the deadline.
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    return fetcher(url.pathname + url.search, { ...init, headers, signal, credentials: "same-origin", cache: "no-store" });
  };
  const api = createNovartApiClient(scopedFetch);
  const session = createDocumentSession(api, workspaceId, projectId);
  const endpoint = (name: string, extra: Record<string, string> = {}) => name + "?" + new URLSearchParams({ projectId, ...extra });
  async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const writing = !["GET", "HEAD"].includes(init.method ?? "GET");
    try {
      const response = await scopedFetch(path, { ...init, signal: controller.signal });
      const body = await response.json().catch(() => { throw new NovartApiError(controller.signal.aborted ? "响应超时，请刷新任务确认；已提交的任务会继续处理。" : "服务响应暂时无法读取，请刷新任务确认。", controller.signal.aborted || options.signal?.aborted ? null : response.status, undefined, writing); });
      if (!response.ok) throw new NovartApiError(typeof body?.error === "string" ? body.error : "操作未完成，请重试。", response.status, body?.code, writing && response.status >= 500);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new NovartApiError("服务结果不完整，请刷新确认，原内容仍保留。", response.status, "INVALID_RECEIPT", writing);
      return parsed.data;
    } catch (error) {
      if (error instanceof NovartApiError) throw error;
      throw new NovartApiError(controller.signal.aborted ? "响应超时，请刷新任务确认；已提交的任务会继续处理。" : "连接中断，请刷新任务确认。", null, undefined, writing);
    } finally { clearTimeout(timer); }
  }
  function image<T extends PersistentImage>(value: T): T {
    const expected = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(value.assetId)}/raw`;
    if (value.url !== expected || !/^[a-f0-9]{64}$/.test(value.assetSha256)) throw new NovartApiError("图片结果不属于当前品牌。", 422);
    return value;
  }
  function upload(value: UploadTask) {
    if (value.projectId !== projectId) throw new NovartApiError("上传结果不属于当前项目。", 422);
    if (value.material) image(value.material);
    return value;
  }
  function generation(value: GenerationTask) {
    if (value.projectId !== projectId || value.resultState === "READY" && (value.status !== "SUCCEEDED" || !value.results.length)) throw new NovartApiError("生成结果不属于当前项目或尚未完成。", 422);
    value.results.forEach(image);
    return value;
  }
  function decomposition(value: DecompositionTask) {
    if (value.projectId !== projectId) throw new NovartApiError("分层任务不属于当前项目。", 422);
    value.layers.forEach(image);
    return value;
  }
  function decompositionExportUrl(value: DecompositionTask) {
    decomposition(value);
    if (value.status !== "SUCCEEDED") throw new NovartApiError("图层尚未完整保存，暂不能下载 PSD。", 422);
    return `/api/workspaces/${encodeURIComponent(workspaceId)}/studio/decomposition/${encodeURIComponent(value.requestId)}/export?` + new URLSearchParams({ projectId, format: "psd" });
  }
  function generatedPsd(value: GeneratedPsdTask, requestId: string) {
    if (value.projectId !== projectId || value.requestId !== requestId || value.requested === (value.status === "NOT_REQUESTED")) throw new NovartApiError("PSD 任务结果与当前项目不一致。", 422);
    if (value.decomposition) decomposition(value.decomposition);
    if (value.status === "READY") {
      if (!value.decomposition || !value.downloadUrl) throw new NovartApiError("PSD 图层还未确认保存，请刷新任务。", 422);
      const expected = decompositionExportUrl(value.decomposition), received = new URL(value.downloadUrl, origin), target = new URL(expected, origin);
      if (received.origin !== origin || received.username || received.password || received.hash || received.pathname !== target.pathname
        || received.searchParams.size !== 2 || received.searchParams.get("projectId") !== projectId || received.searchParams.get("format") !== "psd") throw new NovartApiError("PSD 下载地址不属于当前项目。", 422);
      return { ...value, downloadUrl: expected };
    }
    if (value.downloadUrl !== null || !value.requested && (value.decomposition !== null || value.error !== null)) throw new NovartApiError("PSD 结果尚未完整确认。", 422);
    return value;
  }
  const getUpload = async (taskId: string, timeoutMs = 20000) => {
    const value = upload(await request(endpoint("/studio/material-upload", { taskId }), StudioMaterialUploadView, {}, timeoutMs));
    if (value.taskId !== taskId) throw new NovartApiError("上传任务结果与请求不一致。", 422);
    return value;
  };
  const readWorkflow = async () => {
    const value = await request(endpoint("/workflow"), StudioWorkflowView);
    if (value.projectId !== projectId) throw new NovartApiError("素材用途不属于当前项目。", 422);
    return value;
  };
  return {
    async readProjectContext() {
      const value = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/studio-project-context`, StudioProjectContextView);
      if (value.projectId !== projectId) throw new NovartApiError("项目资料不属于当前项目。", 422);
      return value;
    },
    async saveProjectContext(input: ProjectContextInput) {
      const payload = StudioProjectContextSaveInput.parse(input);
      const value = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/studio-project-context`, StudioProjectContextView,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const factsMatch = Object.entries(payload.facts).every(([key, text]) => value.facts[key as keyof typeof value.facts] === text);
      const materialsMatch = value.materials.length === payload.materials.length && payload.materials.every((item, index) => {
        const saved = value.materials[index]; return saved?.assetId === item.assetId && saved.assetSha256 === item.assetSha256 && saved.role === item.role;
      });
      const masterMatch = !payload.master ? value.master === null : value.master?.assetId === payload.master.assetId
        && value.master.assetSha256 === payload.master.assetSha256 && value.master.shapeId === (payload.master.shapeId ?? null)
        && (!payload.master.versionId || value.master.versionId === payload.master.versionId);
      if (value.projectId !== projectId || value.revision !== payload.expectedRevision + 1 || !factsMatch || !materialsMatch || !masterMatch) throw new NovartApiError("项目资料保存结果尚未确认，请读取最新资料。", null, "INVALID_RECEIPT", true);
      return value;
    },
    getImageToolCapabilities: () => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/studio-image-tools`, StudioImageToolCapabilities),
    async submitImageTool(input: z.infer<typeof StudioImageToolInput>) {
      const payload = StudioImageToolInput.parse(input);
      if (payload.projectId !== projectId) throw new NovartApiError("图片工具不属于当前项目。", 422);
      const receipt = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/studio-image-tools`, StudioGenerationView,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      try {
        const value = generation(receipt);
        if (value.mutationId !== payload.mutationId || value.mode !== "modify" || value.sourceShapeId && value.sourceShapeId !== payload.target.shapeId) throw new Error("图片工具结果与原请求不一致。");
        return value;
      } catch (error) { throw new NovartApiError(error instanceof Error ? error.message : "图片工具结果尚未核对。", null, "INVALID_RECEIPT", true); }
    },
    api, session, image, readWorkflow, decompositionExportUrl,
    async getGeneratedPsd(requestId: string, timeoutMs = 20000) {
      return generatedPsd(await request(endpoint(`/api/workspaces/${encodeURIComponent(workspaceId)}/studio/generated-psd`, { requestId }), StudioGeneratedPsdView, {}, timeoutMs), requestId);
    },
    async downloadPsd(task: DecompositionTask) {
      const path = decompositionExportUrl(task), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
      const maximum = 96 * 1024 * 1024;
      try {
        const response = await scopedFetch(path, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new NovartApiError(typeof body?.error === "string" ? body.error : "PSD 导出未完成，请稍后重试，原图和图层仍保留。", response.status);
        }
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        const declaredLength = response.headers.get("content-length");
        if (!["image/vnd.adobe.photoshop", "application/octet-stream", "application/vnd.adobe.photoshop"].includes(contentType ?? "")
          || declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximum || Number(declaredLength) < 26)) {
          await response.body?.cancel(); throw new NovartApiError("PSD 响应格式或文件大小不正确，原图和图层仍保留。", 422);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new NovartApiError("PSD 文件尚未返回，请稍后重试。", 422);
        const chunks: Uint8Array<ArrayBuffer>[] = []; let total = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            total += part.value.byteLength;
            if (total > maximum || controller.signal.aborted || options.signal?.aborted) throw new NovartApiError("PSD 下载超过限制或已中止，原图和图层仍保留。", 422);
            chunks.push(new Uint8Array(part.value));
          }
        } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
        if (declaredLength !== null && Number(declaredLength) !== total || total < 26) throw new NovartApiError("PSD 下载不完整，请重试，原图和图层仍保留。", 422);
        const blob = new Blob(chunks, { type: "image/vnd.adobe.photoshop" }), header = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
        const view = new DataView(header.buffer), signature = new TextDecoder().decode(header.slice(0, 4));
        if (signature !== "8BPS" || view.getUint16(4) !== 1 || header.slice(6, 12).some(value => value !== 0)
          || view.getUint16(12) < 1 || view.getUint16(12) > 56 || view.getUint32(14) !== task.sourceHeight || view.getUint32(18) !== task.sourceWidth
          || view.getUint16(22) !== 8 || view.getUint16(24) !== 3) throw new NovartApiError("PSD 文件头或原图尺寸不正确，未下载错误文件。", 422);
        return { blob, fileName: `DeepFlare-${task.requestId}.psd` };
      } catch (error) {
        if (error instanceof NovartApiError) throw error;
        throw new NovartApiError(controller.signal.aborted ? "PSD 导出超时，请稍后重试，原图和图层仍保留。" : "PSD 下载中断，原图和图层仍保留。", null);
      } finally { clearTimeout(timer); }
    },
    listDecompositions: async () => (await request(endpoint("/studio/decomposition"), z.object({ requests: z.array(StudioDecompositionView) }).strict())).requests.map(decomposition),
    async getDecomposition(requestId: string) {
      const value = decomposition(await request(endpoint("/studio/decomposition", { requestId }), StudioDecompositionView));
      if (value.requestId !== requestId) throw new NovartApiError("分层任务结果与请求不一致。", 422);
      return value;
    },
    async submitDecomposition(raw: DecompositionInput) {
      const input = StudioDecompositionInput.parse(raw);
      if (input.projectId !== projectId) throw new NovartApiError("分层输入不属于当前项目。", 400);
      const receipt = await request(endpoint("/studio/decomposition"), StudioDecompositionView,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      let result: DecompositionTask;
      try { result = decomposition(receipt); }
      catch { throw new NovartApiError("分层提交结果的品牌或项目不一致，请先核对已有任务。", null, "INVALID_RECEIPT", true); }
      if (!matchesOwnedDecomposition(input, result)) {
        throw new NovartApiError("分层提交结果与原图片不一致，请先读取已有任务。", null, "INVALID_RECEIPT", true);
      }
      return result;
    },
    async retryLayerArchive(requestId: string) {
      const result = decomposition(await request(endpoint("/studio/decomposition/retry-archive"), StudioDecompositionView,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, requestId }) }));
      if (result.requestId !== requestId) throw new NovartApiError("图层保存结果与本次任务不一致。", null, "INVALID_RECEIPT", true);
      return result;
    },
    async workflowAssets() {
      const value = await request(endpoint("/workflow/assets"), StudioWorkflowAssets);
      if (value.projectId !== projectId) throw new NovartApiError("素材选择不属于当前项目。", 422);
      return value;
    },
    async saveWorkflow(input: WorkflowInput) {
      const payload = StudioWorkflowSaveInput.parse(input);
      if (payload.projectId !== projectId) throw new NovartApiError("素材设置不属于当前项目。", 400);
      const value = await request(endpoint("/workflow"), StudioWorkflowView, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (value.projectId !== projectId || value.revision !== payload.revision + 1
        || JSON.stringify([value.mode, value.target, value.references]) !== JSON.stringify([payload.mode, payload.target, payload.references])) {
        throw new NovartApiError("素材设置的保存结果未确认，请读取服务器结果后继续。", null, "INVALID_RECEIPT", true);
      }
      return value;
    },
    listMaterials: async () => (await request(endpoint("/studio/materials"), z.array(StudioMaterial))).map(image),
    listUploads: async () => (await request(endpoint("/studio/material-upload"), z.object({ tasks: z.array(StudioMaterialUploadView) }))).tasks.map(upload),
    listGenerations: async () => (await request(endpoint("/studio/generation"), z.object({ requests: z.array(StudioGenerationView) }))).requests.map(generation),
    getUpload,
    async getGeneration(requestId: string) {
      const value = generation(await request(endpoint("/studio/generation", { requestId }), StudioGenerationView));
      if (value.requestId !== requestId) throw new NovartApiError("生成任务结果与请求不一致。", 422);
      return value;
    },
    async retryArchive(requestId: string) {
      const value = generation(await request(endpoint("/studio/generation/retry-archive"), StudioGenerationView,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, requestId }) }));
      if (value.requestId !== requestId) throw new NovartApiError("归档结果与当前任务不一致，请刷新确认。", null, "INVALID_RECEIPT", true);
      return value;
    },
    async readCompliance(versionId: string, retry = false) {
      const value = await request(endpoint(retry ? "/studio/generation/compliance/retry" : "/studio/generation/compliance", retry ? {} : { versionId }), StudioGenerationComplianceView,
        retry ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, versionId }) } : {});
      if (value.versionId !== versionId) throw new NovartApiError("品牌检查结果与当前图片不一致，请刷新确认。", retry ? null : 422, "INVALID_RECEIPT", retry);
      return value;
    },
    async uploadFile(file: File, mutationId: string) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) throw new NovartApiError("请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。", 400);
      const form = new FormData(); form.set("projectId", projectId); form.set("mutationId", mutationId); form.set("file", file, file.name || "image.png");
      const receipt = await request(endpoint("/studio/material-upload"), StudioMaterialUploadView, { method: "POST", body: form });
      try {
        const value = upload(receipt);
        if (value.mutationId !== mutationId) throw new Error("上传结果与本次请求不一致，请读取原任务确认。");
        return value;
      } catch (error) { throw new NovartApiError(error instanceof Error ? error.message : "上传结果尚未核对。", null, "INVALID_RECEIPT", true); }
    },
    async pollUpload(initial: UploadTask, onProgress: (value: UploadTask) => void, maxMs = 120000) {
      let task = upload(initial), failures = 0;
      const deadline = Math.min(Date.now() + Math.min(maxMs, 120000), Date.parse(task.expiresAt));
      while (task.status === "PENDING" || task.status === "RUNNING") {
        if (options.signal?.aborted) throw new NovartApiError("页面已关闭，已提交的任务仍会处理。", null);
        const remaining = deadline - Date.now();
        if (remaining <= 0) return task;
        await new Promise<void>(resolve => { const signal = options.signal; const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, Math.min(1500, remaining)); signal?.addEventListener("abort", done, { once: true }); });
        if (options.signal?.aborted || Date.now() >= deadline) return task;
        try { task = await getUpload(task.taskId, Math.min(20000, deadline - Date.now())); failures = 0; onProgress(task); }
        catch (error) {
          failures++;
          if (!(error instanceof NovartApiError) || error.status !== null && error.status < 500 || failures >= 3) throw error;
        }
      }
      return task;
    },
    async submitGeneration(input: GenerationInput) {
      const payload = StudioGenerationInput.parse(input);
      if (payload.projectId !== projectId) throw new NovartApiError("生成请求不属于当前项目。", 400);
      const receipt = await request(endpoint("/studio/generation"), StudioGenerationView, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      try {
        const value = generation(receipt);
        if (value.mutationId !== payload.mutationId || !matchesOwnedPsdSelection(payload, value)) throw new Error("生成结果与本次需求或 PSD 选择不一致，请刷新任务确认。");
        return value;
      } catch (error) {
        // The server accepted the POST. A foreign or inconsistent reply is not
        // a definitive rejection: keep the original paid-request mutation.
        throw new NovartApiError(error instanceof Error ? error.message : "生成结果尚未核对，请刷新任务确认。", null, "INVALID_RECEIPT", true);
      }
    },
  };
}
