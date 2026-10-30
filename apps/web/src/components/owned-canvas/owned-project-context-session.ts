import { NovartApiError } from "../../lib/novart-api-client";
import type { createOwnedEditorApi, ProjectContext, ProjectContextInput } from "./owned-editor-api";

export type ProjectContextDraft = Pick<ProjectContextInput, "facts" | "materials" | "master">;
export type ProjectContextState = {
  server: ProjectContext | null; draft: ProjectContextDraft | null; latest: ProjectContext | null;
  dirty: boolean; busy: boolean; status: "loading" | "ready" | "uncertain" | "conflict" | "error"; error: string;
};
type Api = Pick<ReturnType<typeof createOwnedEditorApi>, "readProjectContext" | "saveProjectContext">;
export const projectContextDraft = (value: ProjectContext | ProjectContextDraft): ProjectContextDraft => ({
  facts: { ...value.facts }, materials: value.materials.map(({ assetId, assetSha256, role }) => ({ assetId, assetSha256, role })),
  master: value.master ? { assetId: value.master.assetId, assetSha256: value.master.assetSha256,
    ...(value.master.shapeId ? { shapeId: value.master.shapeId } : {}), ...(value.master.versionId ? { versionId: value.master.versionId } : {}) } : null,
});
const selection = (value: ProjectContext | ProjectContextDraft) => {
  const draft = projectContextDraft(value);
  return JSON.stringify({ ...draft, facts: Object.fromEntries(Object.entries(draft.facts).map(([key, text]) => [key, text.trim()])) });
};
export const hasProjectContext = (value: ProjectContext | null | undefined) => !!value && (Object.values(value.facts).some(text => text.trim()) || !!value.materials.length || !!value.master);
const message = (error: unknown) => error instanceof Error ? error.message : "项目资料尚未确认，请稍后继续。";

/** Only the server owns confirmed project information. A pending write keeps
 * its mutation identity until acknowledged; local drafts never become facts. */
export function createOwnedProjectContextSession(api: Api, options: { canWrite(): boolean; saveDocument(): Promise<number> }) {
  let value: ProjectContextState = { server: null, draft: null, latest: null, dirty: false, busy: false, status: "loading", error: "" };
  let pending: ProjectContextInput | null = null, disposed = false;
  const listeners = new Set<(state: ProjectContextState) => void>();
  const emit = (next: Partial<ProjectContextState>) => { if (!disposed) { value = { ...value, ...next }; listeners.forEach(fn => fn(value)); } };
  const alive = () => { if (disposed) throw new Error("项目已切换，本次资料操作已停止。"); };
  const writable = () => { alive(); if (!options.canWrite()) throw new Error("项目当前只读，原资料仍保留。"); };
  const accept = (server: ProjectContext) => { pending = null; emit({ server, draft: projectContextDraft(server), latest: null, dirty: false, status: "ready", error: "" }); };
  const conflict = (latest: ProjectContext): never => { emit({ latest, status: "conflict", error: "项目资料已被其他人更新。你的修改仍保留，请选择如何继续。" }); throw new NovartApiError(value.error, 409); };
  async function load() {
    if (disposed || value.busy) return;
    emit({ busy: true });
    try {
      const server = await api.readProjectContext(); alive();
      if (pending) {
        if (server.revision === pending.expectedRevision + 1 && selection(server) === selection(pending)) accept(server);
        else if (server.revision !== pending.expectedRevision || !value.server || selection(server) !== selection(value.server)) conflict(server);
        else emit({ status: "uncertain", error: "上次保存尚未确认。可继续确认同一份资料，请勿重复新建。" });
      } else if (value.dirty || value.status === "conflict") {
        if (server.revision !== value.server?.revision || selection(server) !== selection(value.server)) conflict(server);
        emit({ server, status: "ready", error: "" });
      } else accept(server);
    } catch (error) { if (!disposed) emit({ status: value.status === "conflict" ? "conflict" : pending ? "uncertain" : "error", error: message(error) }); }
    finally { emit({ busy: false }); }
  }
  async function save() {
    writable();
    if (value.busy || !value.draft || !value.server) throw new Error("项目资料尚未读取完成，请稍后再试。");
    if (value.status === "conflict") throw new Error("请先处理项目资料的版本冲突。");
    if (!pending && !value.dirty) return value.server;
    emit({ busy: true, error: "" });
    try {
      if (pending) {
        const latest = await api.readProjectContext(); writable();
        if (latest.revision === pending.expectedRevision + 1 && selection(latest) === selection(pending)) { accept(latest); return latest; }
        if (latest.revision !== pending.expectedRevision || selection(latest) !== selection(value.server)) conflict(latest);
      } else {
        const draft = projectContextDraft(value.draft);
        const documentRevision = draft.master?.shapeId ? await options.saveDocument() : undefined; writable();
        pending = { ...draft, mutationId: crypto.randomUUID(), expectedRevision: value.server.revision, ...(documentRevision === undefined ? {} : { documentRevision }) };
      }
      const saved = await api.saveProjectContext(pending); alive(); accept(saved); return saved;
    } catch (error) {
      if (!disposed) {
        if (error instanceof NovartApiError && error.status === 409) {
          emit({ status: "conflict", error: message(error) });
          try { const latest = await api.readProjectContext(); alive(); emit({ latest }); } catch { /* Keep the draft until an explicit refresh succeeds. */ }
        } else {
          if (!(error instanceof NovartApiError && error.uncertain)) pending = null;
          emit({ status: pending ? "uncertain" : "error", error: message(error) });
        }
      }
      throw error;
    } finally { emit({ busy: false }); }
  }
  async function confirmForUse() {
    writable();
    if (!value.server || value.busy || value.dirty || pending || value.status !== "ready") throw new Error("请先保存并确认项目资料，或关闭本轮沿用资料。");
    const expected = value.server; emit({ busy: true });
    try {
      const latest = await api.readProjectContext(); writable();
      if (latest.revision !== expected.revision || selection(latest) !== selection(expected)) conflict(latest);
      accept(latest);
      if (latest.issues.length) throw new Error("项目资料中的图片来源已变化，请在项目资料里重新选择或移除，再继续使用。");
      return latest;
    } finally { emit({ busy: false }); }
  }
  return {
    snapshot: () => value, load, save, confirmForUse,
    subscribe(fn: (state: ProjectContextState) => void) { listeners.add(fn); fn(value); return () => { listeners.delete(fn); }; },
    dispose() { disposed = true; listeners.clear(); },
    change(update: (draft: ProjectContextDraft) => ProjectContextDraft) {
      writable(); if (!value.draft || value.busy || pending || value.status === "conflict") throw new Error("请先确认上一份项目资料。");
      const draft = projectContextDraft(update(projectContextDraft(value.draft)));
      if (draft.materials.length > 7) throw new Error("项目资料最多设置 7 张职责图片，请先移除不用的素材。");
      emit({ draft, dirty: selection(draft) !== selection(value.server!), status: "ready", error: "" });
    },
    resolveConflict(choice: "server" | "local") {
      writable(); if (!value.latest || !value.draft || value.busy) throw new Error("请先读取最新项目资料。");
      const latest = value.latest, draft = value.draft; pending = null;
      if (choice === "server") accept(latest);
      else emit({ server: latest, draft, latest: null, dirty: selection(draft) !== selection(latest), status: "ready", error: "已保留你的修改，请对照检查后重新保存。" });
    },
  };
}
export type OwnedProjectContextSession = ReturnType<typeof createOwnedProjectContextSession>;
