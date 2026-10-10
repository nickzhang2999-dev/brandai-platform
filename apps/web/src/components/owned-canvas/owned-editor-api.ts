import { z } from "zod";
import { StudioGenerationInput, StudioGenerationView, StudioGenerationComplianceView, StudioMaterial, StudioMaterialUploadView, StudioWorkflowView, StudioWorkflowAssets, StudioWorkflowSaveInput } from "@brandai/contracts";
import { createDocumentSession, createNovartApiClient, NovartApiError } from "../../lib/novart-api-client";

export type Material = z.infer<typeof StudioMaterial>;
export type UploadTask = z.infer<typeof StudioMaterialUploadView>;
export type GenerationTask = z.infer<typeof StudioGenerationView>;
export type GenerationCompliance = z.infer<typeof StudioGenerationComplianceView>;
export type Workflow = z.infer<typeof StudioWorkflowView>;
export type WorkflowAssets = z.infer<typeof StudioWorkflowAssets>;
export type WorkflowInput = z.infer<typeof StudioWorkflowSaveInput>;
export type GenerationInput = z.infer<typeof StudioGenerationInput>;
export type PersistentImage = Pick<Material, "assetId" | "assetSha256" | "width" | "height" | "url"> & { versionId?: string; fileName?: string };

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
      const body = await response.json().catch(() => { throw new NovartApiError(controller.signal.aborted ? "响应超时，请刷新任务确认；已受理任务会继续处理。" : "服务响应暂时无法读取，请刷新任务确认。", controller.signal.aborted || options.signal?.aborted ? null : response.status, undefined, writing); });
      if (!response.ok) throw new NovartApiError(typeof body?.error === "string" ? body.error : "操作未完成，请重试。", response.status, body?.code, writing && response.status >= 500);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new NovartApiError("服务回执不完整，请刷新确认，原内容仍保留。", response.status, "INVALID_RECEIPT", writing);
      return parsed.data;
    } catch (error) {
      if (error instanceof NovartApiError) throw error;
      throw new NovartApiError(controller.signal.aborted ? "响应超时，请刷新任务确认；已受理任务会继续处理。" : "连接中断，请刷新任务确认。", null, undefined, writing);
    } finally { clearTimeout(timer); }
  }
  function image<T extends PersistentImage>(value: T): T {
    const expected = `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(value.assetId)}/raw`;
    if (value.url !== expected || !/^[a-f0-9]{64}$/.test(value.assetSha256)) throw new NovartApiError("图片回执不属于当前品牌。", 422);
    return value;
  }
  function upload(value: UploadTask) {
    if (value.projectId !== projectId) throw new NovartApiError("上传回执不属于当前项目。", 422);
    if (value.material) image(value.material);
    return value;
  }
  function generation(value: GenerationTask) {
    if (value.projectId !== projectId || value.resultState === "READY" && (value.status !== "SUCCEEDED" || !value.results.length)) throw new NovartApiError("生成回执不属于当前项目或尚未完成。", 422);
    value.results.forEach(image);
    return value;
  }
  const getUpload = async (taskId: string, timeoutMs = 20000) => {
    const value = upload(await request(endpoint("/studio/material-upload", { taskId }), StudioMaterialUploadView, {}, timeoutMs));
    if (value.taskId !== taskId) throw new NovartApiError("上传任务回执与请求不一致。", 422);
    return value;
  };
  const readWorkflow = async () => {
    const value = await request(endpoint("/workflow"), StudioWorkflowView);
    if (value.projectId !== projectId) throw new NovartApiError("素材用途不属于当前项目。", 422);
    return value;
  };
  return {
    api, session, image, readWorkflow,
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
        throw new NovartApiError("素材设置的保存回执未确认，请读取服务器结果后继续。", null, "INVALID_RECEIPT", true);
      }
      return value;
    },
    listMaterials: async () => (await request(endpoint("/studio/materials"), z.array(StudioMaterial))).map(image),
    listUploads: async () => (await request(endpoint("/studio/material-upload"), z.object({ tasks: z.array(StudioMaterialUploadView) }))).tasks.map(upload),
    listGenerations: async () => (await request(endpoint("/studio/generation"), z.object({ requests: z.array(StudioGenerationView) }))).requests.map(generation),
    getUpload,
    async getGeneration(requestId: string) {
      const value = generation(await request(endpoint("/studio/generation", { requestId }), StudioGenerationView));
      if (value.requestId !== requestId) throw new NovartApiError("生成任务回执与请求不一致。", 422);
      return value;
    },
    async retryArchive(requestId: string) {
      const value = generation(await request(endpoint("/studio/generation/retry-archive"), StudioGenerationView,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, requestId }) }));
      if (value.requestId !== requestId) throw new NovartApiError("归档回执与当前任务不一致，请刷新确认。", null, "INVALID_RECEIPT", true);
      return value;
    },
    async readCompliance(versionId: string, retry = false) {
      const value = await request(endpoint(retry ? "/studio/generation/compliance/retry" : "/studio/generation/compliance", retry ? {} : { versionId }), StudioGenerationComplianceView,
        retry ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, versionId }) } : {});
      if (value.versionId !== versionId) throw new NovartApiError("品牌检查回执与当前图片不一致，请刷新确认。", retry ? null : 422, "INVALID_RECEIPT", retry);
      return value;
    },
    async uploadFile(file: File, mutationId: string) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) throw new NovartApiError("请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。", 400);
      const form = new FormData(); form.set("projectId", projectId); form.set("mutationId", mutationId); form.set("file", file, file.name || "image.png");
      const value = upload(await request(endpoint("/studio/material-upload"), StudioMaterialUploadView, { method: "POST", body: form }));
      if (value.mutationId !== mutationId) throw new NovartApiError("上传回执与本次请求不一致，请刷新任务确认。", 409);
      return value;
    },
    async pollUpload(initial: UploadTask, onProgress: (value: UploadTask) => void, maxMs = 120000) {
      let task = upload(initial), failures = 0;
      const deadline = Math.min(Date.now() + Math.min(maxMs, 120000), Date.parse(task.expiresAt));
      while (task.status === "PENDING" || task.status === "RUNNING") {
        if (options.signal?.aborted) throw new NovartApiError("页面已关闭，已受理任务仍会处理。", null);
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
        if (value.mutationId !== payload.mutationId) throw new Error("生成回执与本次需求不一致，请刷新任务确认。");
        return value;
      } catch (error) {
        // The server accepted the POST. A foreign or inconsistent reply is not
        // a definitive rejection: keep the original paid-request mutation.
        throw new NovartApiError(error instanceof Error ? error.message : "生成回执尚未核对，请刷新任务确认。", null, "INVALID_RECEIPT", true);
      }
    },
  };
}
