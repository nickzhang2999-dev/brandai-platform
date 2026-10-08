import { EditorDocumentSaveInput, EditorDocumentView, WorkbenchSession } from "@brandai/contracts";

export class NovartApiError extends Error {
  constructor(message: string, public status: number | null, public code?: string, public uncertain = false) { super(message); }
}

/** Shared by the reviewed shell and native-editor adapter. Auth is the HttpOnly session cookie. */
export function createNovartApiClient(fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const writing = !["GET", "HEAD"].includes(init.method ?? "GET");
    try {
      const response = await fetcher(path, { ...init, signal: controller.signal, credentials: "same-origin", cache: "no-store" });
      const data = await response.json().catch(() => { throw new NovartApiError("服务返回了无法读取的内容。", response.status, undefined, writing); });
      if (!response.ok) throw new NovartApiError(data.error || "请求失败，请重试。", response.status, data.code, writing && response.status >= 500);
      return data as T;
    } catch (error) {
      if (error instanceof NovartApiError) throw error;
      throw new NovartApiError(controller.signal.aborted ? "请求超时，请核对保存结果后再重试。" : "连接中断，请核对保存结果后再重试。", null, undefined, writing);
    } finally { clearTimeout(timer); }
  }
  const json = (method: string, data: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const scope = (ws: string) => `/api/workspaces/${encodeURIComponent(ws)}`;
  const project = (ws: string, id: string) => `${scope(ws)}/projects/${encodeURIComponent(id)}`;
  return {
    session: async (workspaceId?: string) => WorkbenchSession.parse(await request("/api/workbench/session" + (workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""))),
    selectWorkspace: async (workspaceId: string) => WorkbenchSession.parse(await request("/api/workbench/session", json("POST", { workspaceId }))),
    listProjects: (ws: string) => request<Array<{ id: string; name: string; archivedAt?: string | null }>>(`${scope(ws)}/projects`),
    createProject: (ws: string, name: string) => request<{ id: string; name: string }>(`${scope(ws)}/projects`, json("POST", { name })),
    archiveProject: (ws: string, id: string, archive: boolean) => request(project(ws, id), json("PATCH", { archive })),
    uploadAsset: async (ws: string, file: File) => {
      const form = new FormData(); form.set("file", file); form.set("category", "OTHER"); form.set("libraryKind", "MATERIAL");
      const asset = await request<{ id: string; url: string }>(`${scope(ws)}/assets/upload`, { method: "POST", body: form }, 60000);
      return { ...asset, canvasUrl: `${scope(ws)}/assets/${encodeURIComponent(asset.id)}/raw` };
    },
    listAssets: (ws: string) => request(`${scope(ws)}/assets`),
    readDocument: async (ws: string, id: string) => EditorDocumentView.parse(await request(`${project(ws, id)}/editor-document`)),
    saveDocument: async (ws: string, id: string, input: EditorDocumentSaveInput) => EditorDocumentView.parse(
      await request(`${project(ws, id)}/editor-document`, json("PUT", EditorDocumentSaveInput.parse(input)))),
  };
}

/** A save attempt is immutable across retry; conflicts never auto-overwrite newer data. */
export function createDocumentSession(api: ReturnType<typeof createNovartApiClient>, workspaceId: string, projectId: string) {
  let current: EditorDocumentView | null = null;
  let pending: EditorDocumentSaveInput | null = null;
  let busy = false;
  let blocked = false;
  return {
    get pending() { return pending !== null; },
    async load() {
      if (busy || pending) throw new NovartApiError("还有未确认的保存，请先重试保存或明确放弃当前修改。", 409);
      current = null;
      busy = true;
      try { current = await api.readDocument(workspaceId, projectId); blocked = false; return current; }
      finally { busy = false; }
    },
    async save(canvas: string) {
      if (!current) throw new NovartApiError("画布尚未读取完成，不能保存。", 409);
      if (current.readOnly) throw new NovartApiError("该项目当前只读。", 403);
      if (blocked) throw new NovartApiError("保存发生冲突，请保留当前内容并重新打开项目处理。", 409, "DOCUMENT_CONFLICT");
      if (busy) throw new NovartApiError("上一份保存尚未完成。", 409);
      if (pending && pending.canvas !== canvas) throw new NovartApiError("上一份保存结果尚未确认，请先重试原保存。", 409);
      pending ??= { format: "novart-native-v1", canvas, revision: current.revision, mutationId: crypto.randomUUID() };
      busy = true;
      try { current = await api.saveDocument(workspaceId, projectId, pending); pending = null; return current; }
      catch (error) {
        if (error instanceof NovartApiError && error.status === 409) blocked = true;
        if (error instanceof NovartApiError && !error.uncertain) pending = null;
        throw error;
      } finally { busy = false; }
    },
  };
}
