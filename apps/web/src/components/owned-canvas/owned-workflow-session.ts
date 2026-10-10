import { NovartApiError } from "../../lib/novart-api-client";
import type { createOwnedEditorApi, Workflow, WorkflowAssets, WorkflowInput } from "./owned-editor-api";

type Api = Pick<ReturnType<typeof createOwnedEditorApi>, "readWorkflow" | "workflowAssets" | "saveWorkflow">;
export type WorkflowSessionState = {
  server: Workflow | null; draft: WorkflowInput | null; assets: WorkflowAssets | null; latest: Workflow | null;
  dirty: boolean; busy: boolean; status: "loading" | "ready" | "uncertain" | "conflict" | "error"; error: string;
};
export const workflowSelection = (value: Pick<WorkflowInput, "mode" | "target" | "references">) => JSON.stringify([
  value.mode, value.target && [value.target.shapeId, value.target.assetSha256],
  value.references.map(ref => [ref.shapeId, ref.assetSha256, ref.purpose, ref.participates]),
]);
export const workflowInput = (value: Workflow | WorkflowInput): WorkflowInput => ({ projectId: value.projectId, revision: value.revision,
  mode: value.mode, target: value.target ? { ...value.target } : null, references: value.references.map(ref => ({ ...ref })) });
const message = (error: unknown) => error instanceof Error ? error.message : "素材设置尚未确认，请稍后继续。";

/** Workflow writes have revisions, not idempotency tokens. After a lost reply
 * read first: only an exact next-revision match may acknowledge the write.
 * An unchanged old revision can safely retry; every other state needs a choice. */
export function createOwnedWorkflowSession(api: Api, options: { canWrite: () => boolean; saveDocument: () => Promise<void> }) {
  let value: WorkflowSessionState = { server: null, draft: null, assets: null, latest: null, dirty: false, busy: false, status: "loading", error: "" };
  let pending: WorkflowInput | null = null, disposed = false;
  const listeners = new Set<(state: WorkflowSessionState) => void>();
  const emit = (next: Partial<WorkflowSessionState>) => { if (!disposed) { value = { ...value, ...next }; listeners.forEach(fn => fn(value)); } };
  const alive = () => { if (disposed) throw new Error("项目已切换，本次素材操作已停止。"); };
  const writable = () => { alive(); if (!options.canWrite()) throw new Error("项目当前只读，原素材设置保留。"); };
  const accept = (server: Workflow) => { pending = null; emit({ server, draft: workflowInput(server), latest: null, dirty: false, status: "ready", error: "" }); };
  const conflict = (latest?: Workflow): never => { emit({ latest: latest ?? value.latest, status: "conflict", error: "素材设置已有其他版本。当前选择仍保留，请对照最新设置后决定。" }); throw new NovartApiError(value.error, 409); };
  async function load() {
    if (disposed || value.busy) return;
    emit({ busy: true });
    try {
      const [server, assets] = await Promise.all([api.readWorkflow(), api.workflowAssets()]); alive(); emit({ assets });
      if (pending) {
        if (server.revision === pending.revision + 1 && workflowSelection(server) === workflowSelection(pending)) accept(server);
        else if (server.revision !== pending.revision || workflowSelection(server) !== workflowSelection(value.server!)) conflict(server);
        else emit({ latest: null, status: "uncertain", error: "服务器尚未确认这份设置，可继续确认同一份保存。" });
      } else if (value.dirty || value.status === "conflict") {
        if (server.revision !== value.server?.revision || workflowSelection(server) !== workflowSelection(value.server)) conflict(server);
        emit({ server, status: "ready", error: "" });
      } else accept(server);
    } catch (error) { if (!disposed) emit({ error: message(error), status: value.status === "conflict" ? "conflict" : pending ? "uncertain" : "error" }); }
    finally { emit({ busy: false }); }
  }
  async function save() {
    writable();
    if (value.busy) throw new Error("素材设置正在确认，请稍后继续。");
    if (!value.draft || !value.server) throw new Error("请先读取素材设置。");
    if (value.status === "conflict") throw new Error("请先处理素材版本冲突，当前选择仍保留。");
    if (!pending && !value.dirty) return value.server;
    emit({ busy: true, error: "" });
    try {
      await options.saveDocument(); writable();
      if (pending) {
        const latest = await api.readWorkflow(); writable();
        if (latest.revision === pending.revision + 1 && workflowSelection(latest) === workflowSelection(pending)) { accept(latest); return latest; }
        if (latest.revision !== pending.revision || workflowSelection(latest) !== workflowSelection(value.server)) conflict(latest);
      } else pending = workflowInput(value.draft);
      const saved = await api.saveWorkflow(pending); writable(); accept(saved); return saved;
    } catch (error) {
      if (!disposed) {
        if (error instanceof NovartApiError && error.status === 409) {
          emit({ status: "conflict", error: message(error) });
          try { const latest = await api.readWorkflow(); alive(); emit({ latest }); } catch { /* Keep the local selection until an explicit refresh succeeds. */ }
        } else {
          if (!(error instanceof NovartApiError && error.uncertain)) pending = null;
          emit({ status: pending ? "uncertain" : "error", error: message(error) });
        }
      }
      throw error;
    } finally { emit({ busy: false }); }
  }
  async function confirmForGeneration() {
    writable();
    if (!value.server || value.busy || value.dirty || pending || value.status !== "ready") throw new Error("请先保存或确认素材用途，再提交创作。");
    const expected = value.server; emit({ busy: true });
    try {
      const latest = await api.readWorkflow(); writable();
      if (latest.revision !== expected.revision || workflowSelection(latest) !== workflowSelection(expected)) conflict(latest);
      emit({ server: latest, draft: workflowInput(latest), error: "" });
      const issue = latest.issues.find(item => item.blocking); if (issue) throw new Error(issue.message);
      return latest;
    } finally { emit({ busy: false }); }
  }
  return {
    snapshot: () => value,
    subscribe(fn: (state: WorkflowSessionState) => void) { listeners.add(fn); fn(value); return () => { listeners.delete(fn); }; },
    dispose() { disposed = true; listeners.clear(); },
    load, save, confirmForGeneration,
    change(update: (draft: WorkflowInput) => WorkflowInput) {
      writable(); if (!value.draft || value.busy || pending || value.status === "conflict") throw new Error("请先确认上一份素材设置。");
      const draft = update(workflowInput(value.draft));
      emit({ draft, dirty: workflowSelection(draft) !== workflowSelection(value.server!), status: "ready", error: "" });
    },
    resolveConflict(choice: "server" | "local") {
      writable(); if (!value.latest || !value.draft || value.busy) throw new Error("请先读取最新素材设置。");
      const latest = value.latest, draft = value.draft; pending = null;
      if (choice === "server") accept(latest);
      else emit({ server: latest, draft: { ...workflowInput(draft), revision: latest.revision }, latest: null,
        dirty: workflowSelection(draft) !== workflowSelection(latest), status: "ready", error: "请检查当前选择，再点击保存用途。" });
    },
  };
}
export type OwnedWorkflowSession = ReturnType<typeof createOwnedWorkflowSession>;
