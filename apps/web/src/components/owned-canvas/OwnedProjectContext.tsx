"use client";

import { useState } from "react";
import type { ProjectContextDraft, ProjectContextState } from "./owned-project-context-session";
import { OWNED_TASK_PRESETS, applyOwnedTaskPreset } from "./owned-task-presets";

export type OwnedProjectContextProps = {
  state: ProjectContextState | null; readOnly: boolean; masterName?: string; selectedImageName?: string;
  onChange(update: (draft: ProjectContextDraft) => ProjectContextDraft): void;
  onSave(): void; onRefresh(): void; onResolveConflict(choice: "server" | "local"): void; onSetMaster(): void;
};
const button = "rounded-full border border-border bg-card px-3 py-2 text-xs disabled:opacity-40";
const fields = [
  ["goal", "项目目标", "这次要完成什么、用于哪里", 1000],
  ["audience", "目标受众", "面向谁、希望他们感受到什么", 1000],
  ["approvedCopy", "已确认文案", "准确的品牌名、标题、卖点；未确认的内容先留空", 4000],
  ["visualRequirements", "视觉要求", "已确定的配色、构图、比例或必须保留的内容", 2000],
] as const;

export function OwnedProjectContext(props: OwnedProjectContextProps) {
  const [preset, setPreset] = useState("");
  const state = props.state, draft = state?.draft;
  const locked = props.readOnly || !draft || !!state?.busy || state?.status === "uncertain" || state?.status === "conflict";
  return <details data-testid="owned-project-context" className="rounded-2xl border border-border bg-card">
    <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-3 text-xs font-semibold"><span>项目资料</span><span className="font-normal text-muted-foreground">{state?.dirty ? "有未保存修改" : state?.server?.updatedAt ? "已保存" : "待补充"}</span></summary>
    <div className="space-y-3 border-t border-border px-3 pb-3 pt-2">
      <p className="text-xs leading-5 text-muted-foreground">确认一次，后续创作可沿用。本轮需求和选中的修改对象优先。</p>
      {!draft && <p role="status" className="text-xs">{state?.status === "error" ? "项目资料暂时无法读取。" : "正在读取项目资料…"}</p>}
      {draft && <>
        <div className="space-y-2 text-xs">
          <label className="block space-y-1"><span>项目起点</span><select aria-label="项目起点" disabled={locked} value={preset} onChange={event => setPreset(event.target.value)} className="w-full rounded-xl border border-border bg-background px-2 py-2"><option value="">选择一个起点（可选）</option>{OWNED_TASK_PRESETS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button type="button" className={button} disabled={locked || !preset || !!draft.facts.goal.trim() && !!draft.facts.visualRequirements.trim()} onClick={() => props.onChange(value => applyOwnedTaskPreset(value, preset))}>补充空白目标与要求</button>
          <p className="text-muted-foreground">只补空项，保留已有文案和资料。检查并保存后，后续创作才会沿用。</p>
        </div>
        {fields.map(([key, label, placeholder, maxLength]) => <label key={key} className="block space-y-1 text-xs"><span>{label}</span><textarea aria-label={label} rows={key === "approvedCopy" ? 3 : 2} maxLength={maxLength} placeholder={placeholder} disabled={locked} value={draft.facts[key]} className="w-full resize-y rounded-xl border border-border bg-background px-2 py-2 leading-5 disabled:opacity-60" onChange={event => props.onChange(value => ({ ...value, facts: { ...value.facts, [key]: event.target.value } }))} /></label>)}
        <section aria-label="后续主稿" className="space-y-2 rounded-xl bg-muted p-2">
          <h3 className="text-xs font-semibold">后续主稿</h3>
          <p className="break-words text-xs" data-testid="project-master-name">{draft.master ? props.masterName || "已选主稿" : "尚未选择"}</p>
          <p className="text-xs leading-5 text-muted-foreground">沿用这张图的设计方向；不会替换当前修改对象，也不保证像素完全一致。</p>
          <button type="button" className={button} disabled={locked || !props.selectedImageName} onClick={props.onSetMaster} title={props.selectedImageName ? `使用${props.selectedImageName}` : "先在画布选择一张已保存的图片"}>将选中图片设为主稿</button>
          {draft.master && <button type="button" className={button} disabled={locked} onClick={() => props.onChange(value => ({ ...value, master: null }))}>清除主稿</button>}
        </section>
        {!!draft.materials.length && <section aria-label="已分配素材职责" className="space-y-1 text-xs"><p className="font-medium">已设置 {draft.materials.length} 张素材职责</p><p className="leading-5 text-muted-foreground">在“素材”里区分产品事实、品牌标识、文案内容和视觉风格。</p></section>}
        {!!state?.server?.issues.length && <div role="alert" className="space-y-2 rounded-xl border border-primary/30 bg-accent-soft p-2 text-xs"><p>部分图片来源已变化，暂不能沿用。请重新选择或移除。</p>{state.server.issues.map(issue => <div key={issue.scope + issue.assetId} className="space-y-1"><span>{issue.scope === "master" ? "后续主稿" : state.server?.materials.find(value => value.assetId === issue.assetId)?.name || "职责素材"}：{issue.code === "SOURCE_CHANGED" ? "内容已变化" : "目前无法读取"}</span>{issue.scope === "material" && <button className="ml-1 underline disabled:opacity-40" disabled={locked} onClick={() => props.onChange(value => ({ ...value, materials: value.materials.filter(item => item.assetId !== issue.assetId) }))}>移除这项职责</button>}</div>)}</div>}
      </>}
      {!!state?.error && <p role="alert" className="text-xs leading-5">{state.error}</p>}
      {state?.status === "conflict" && <div className="space-y-2 text-xs"><p>最新资料：{state.latest?.facts.goal || "项目目标尚未填写"}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={props.readOnly || state.busy || !state.latest} onClick={() => props.onResolveConflict("server")}>采用最新资料</button><button className={button} disabled={props.readOnly || state.busy || !state.latest} onClick={() => props.onResolveConflict("local")}>保留我的修改</button></div><p className="text-muted-foreground">保留后需要检查并再次保存。</p></div>}
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={props.readOnly || !draft || state?.busy || state?.status === "conflict" || !state?.dirty && state?.status !== "uncertain"} onClick={props.onSave}>{state?.busy ? "正在确认…" : state?.status === "uncertain" ? "确认上次保存" : "保存项目资料"}</button><button type="button" className={button} disabled={state?.busy} onClick={props.onRefresh}>读取最新</button></div>
      {props.readOnly && <p className="text-xs text-muted-foreground">当前项目只读。</p>}
    </div>
  </details>;
}
