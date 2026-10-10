"use client";

import { useState } from "react";
import { StudioWorkflowSaveInput } from "@brandai/contracts";
import type { OwnedCanvasDocument } from "../../lib/owned-canvas-model";
import type { WorkflowInput } from "./owned-editor-api";
import type { WorkflowSessionState } from "./owned-workflow-session";

const control = "w-full rounded-xl border border-border bg-bg px-3 py-2 text-xs disabled:opacity-40";
const button = "rounded-full border border-border px-3 py-2 text-xs disabled:opacity-40";
const key = (value: { shapeId: string | null; assetSha256: string }) => JSON.stringify([value.shapeId, value.assetSha256]);
type Props = {
  state: WorkflowSessionState | null; document: OwnedCanvasDocument | null; selectedIds: string[];
  readOnly: boolean; frozen: boolean; outputFrameId: string; onOutputFrameChange: (id: string) => void;
  onCreateOutputFrame: () => void;
  onChange: (update: (draft: WorkflowInput) => WorkflowInput) => void;
  onSave: () => void; onRefresh: () => void; onResolveConflict: (choice: "server" | "local") => void;
};
export function OwnedWorkflowPanel({ state, document, selectedIds, readOnly, frozen, outputFrameId, onOutputFrameChange, onCreateOutputFrame, onChange, onSave, onRefresh, onResolveConflict }: Props) {
  const [candidate, setCandidate] = useState("");
  const draft = state?.draft, assets = state?.assets?.assets ?? [];
  const locked = readOnly || frozen || !draft || !!state?.busy || state?.status === "uncertain" || state?.status === "conflict";
  const frames = document?.items.filter(item => item.kind === "frame") ?? [];
  const exact = draft?.mode === "generate" && draft.references.some(ref => ref.participates && ref.purpose === "EXACT");
  const selectedFrame = frames.find(item => selectedIds.length === 1 && selectedIds[0] === item.id);
  const candidates = assets.filter(asset => asset.valid && !draft?.references.some(ref => key(ref) === key(asset)));
  const selectedAsset = candidates.find(asset => selectedIds.includes(asset.shapeId));
  function add(selected: string) {
    const asset = candidates.find(value => key(value) === selected); if (!asset) return;
    onChange(value => ({ ...value, references: [...value.references, { shapeId: asset.shapeId, assetSha256: asset.assetSha256, purpose: "REFERENCE", participates: false }] })); setCandidate("");
  }
  return <section className="space-y-3 rounded-2xl border border-border p-3" data-testid="owned-workflow" data-workflow-state={state?.status ?? "loading"} data-workflow-dirty={state?.dirty ? "true" : "false"}>
    <div className="flex items-center justify-between"><h2 className="text-xs font-semibold">素材用途</h2><button type="button" className={button} disabled={!!state?.busy || frozen} onClick={onRefresh}>读取最新设置</button></div>
    {!draft ? <p className="text-xs text-muted-fg">{state?.error || "正在读取素材用途…"}</p> : <>
      <label className="block space-y-1 text-xs">创作方式<select aria-label="创作方式" className={control} value={draft.mode} disabled={locked} onChange={event => onChange(value => ({ ...value, mode: event.target.value as "generate" | "modify", target: event.target.value === "generate" ? null : value.target }))}><option value="generate">生成新图</option><option value="modify">修改整张图片</option></select></label>
      {draft.mode === "modify" && <>
        <label className="block space-y-1 text-xs">修改目标<select aria-label="修改目标" className={control} disabled={locked} value={draft.target ? key(draft.target) : ""} onChange={event => { const asset = assets.find(item => key(item) === event.target.value); if (asset) onChange(value => ({ ...value, target: { shapeId: asset.shapeId, assetSha256: asset.assetSha256 } })); }}>
          <option value="" disabled>明确选择一张已保存图片</option>
          {draft.target && !assets.some(asset => key(asset) === key(draft.target!)) && <option value={key(draft.target)}>原目标暂不可用（已保留）</option>}
          {assets.filter(asset => asset.valid).map((asset, index) => <option key={key(asset)} value={key(asset)}>{asset.name} · {index + 1}</option>)}
        </select></label>
        <p className="text-xs leading-5 text-muted-fg">修改的是目标原图，结果作为新图片保留。原图不会被替换；已有严格保留图层由后端沿用，新加入的严格保留素材请使用生成新图。</p>
      </>}
      <div className="space-y-2">{draft.references.map((ref, index) => {
        const asset = assets.find(value => key(value) === key(ref) || ref.shapeId === null && value.assetSha256 === ref.assetSha256), available = !!asset?.valid;
        return <div key={key(ref)} className="space-y-2 rounded-xl bg-bg p-2" data-testid="owned-workflow-reference">
          <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs">{asset?.name || "原引用暂不可用"} · {index + 1}</span><button type="button" className="text-xs underline disabled:opacity-40" disabled={locked} aria-label={`移除素材用途 ${index + 1}`} onClick={() => onChange(value => ({ ...value, references: value.references.filter((_, i) => i !== index) }))}>移除</button></div>
          <select aria-label={`素材用途 ${index + 1}`} className={control} disabled={locked} value={ref.purpose ?? ""} onChange={event => onChange(value => ({ ...value, references: value.references.map((item, i) => i === index ? { ...item, purpose: event.target.value as "EXACT" | "ADAPTIVE" | "REFERENCE" } : item) }))}>
            <option value="" disabled>请选择用途</option><option value="EXACT">严格保留 · 原图内容不改</option><option value="ADAPTIVE">适应性融合 · 允许改绘</option><option value="REFERENCE">视觉参考 · 参考风格构图</option>
          </select>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={`参与生成 ${index + 1}`} checked={ref.participates} disabled={locked || !ref.purpose || !available && !ref.participates} onChange={event => onChange(value => ({ ...value, references: value.references.map((item, i) => i === index ? { ...item, participates: event.target.checked } : item) }))} />参与本次创作</label>
          {!available && <p className="text-xs text-muted-fg">原引用已保留，可停用或明确移除；不会自动换成另一张图。</p>}
        </div>;
      })}</div>
      {draft.references.length < 8 && <div className="space-y-2"><select aria-label="添加画布素材用途" className={control} value={candidate} disabled={locked || !candidates.length} onChange={event => setCandidate(event.target.value)}><option value="">选择一张已保存画布图片</option>{candidates.map((asset, index) => <option key={key(asset)} value={key(asset)}>{asset.name} · {index + 1}</option>)}</select><div className="flex gap-2"><button type="button" className={button} disabled={locked || !candidates.some(asset => key(asset) === candidate)} onClick={() => add(candidate)}>添加用途</button>{selectedAsset && <button type="button" className={button} disabled={locked} onClick={() => add(key(selectedAsset))}>添加选中图片</button>}</div></div>}
      <p className="text-xs leading-5 text-muted-fg">最多 8 张。先保存画布，再读取最新设置；添加后需明确开启参与。同一原图只保留一个参与用途。</p>
      {exact && <div className="space-y-2"><label className="block space-y-1 text-xs">输出画框<select aria-label="输出画框" className={control} value={outputFrameId} disabled={readOnly || frozen || !!state?.busy} onChange={event => onOutputFrameChange(event.target.value)}><option value="">请选择输出画框</option>{outputFrameId && !frames.some(item => item.id === outputFrameId) && <option value={outputFrameId}>原输出画框已删除，请重新选择</option>}{frames.map((item, index) => <option key={item.id} value={item.id}>{item.text || "画框 " + (index + 1)} · {Math.round(item.w)} × {Math.round(item.h)}</option>)}</select></label><div className="flex flex-wrap gap-2">{selectedFrame && <button type="button" className={button} disabled={readOnly || frozen} onClick={() => onOutputFrameChange(selectedFrame.id)}>使用选中的画框</button>}<button type="button" className={button} disabled={readOnly || frozen} onClick={onCreateOutputFrame}>按输出比例新建画框</button></div><p className="text-xs leading-5 text-muted-fg">画框比例需与输出比例一致，严格保留图片需在输出区域内并保持原始比例。保存后由服务器核验布局。</p></div>}
      {!!state?.server?.issues.length && <ul className="space-y-1 text-xs text-muted-fg">{state.server.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
      {!!state?.error && <p role="alert" className="text-xs leading-5">{state.error}</p>}
      {state?.status === "conflict" && state.latest && <div className="space-y-2 rounded-xl bg-accent-soft p-2"><p className="text-xs">服务器最新版本 {state.latest.revision}：{state.latest.mode === "modify" ? "修改图片" : "生成新图"}，{state.latest.references.filter(ref => ref.participates).length} 张参与。</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={readOnly || frozen} onClick={() => onResolveConflict("server")}>采用最新设置</button><button type="button" className={button} disabled={readOnly || frozen} onClick={() => onResolveConflict("local")}>保留我的选择再检查</button></div></div>}
      <button type="button" className={button + " w-full"} disabled={readOnly || frozen || !!state?.busy || state?.status === "conflict" || !state?.dirty && state?.status !== "uncertain" || !StudioWorkflowSaveInput.safeParse(draft).success} onClick={onSave}>{state?.busy ? "正在确认素材…" : state?.status === "uncertain" ? "确认上一份用途保存" : state?.dirty ? "保存用途" : "用途已保存"}</button>
    </>}
  </section>;
}
