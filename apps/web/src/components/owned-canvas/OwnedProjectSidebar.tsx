"use client";

import { useState } from "react";
import { ownedImageName, type OwnedCanvasDocument } from "@/lib/owned-canvas-model";
import { getSceneFlags } from "@/lib/owned-canvas-operations";
import type { Material } from "./owned-editor-api";

type Props = {
  document: OwnedCanvasDocument | null; selectedIds: string[]; materials: Material[]; readOnly: boolean;
  onClose(): void; onChooseImage(id: string): void; onUpload(): void; onOpenLibrary(): void;
  onReference(material: Material): Promise<void> | void; onInsert(material: Material): Promise<void> | void;
  onNotice(message: string): void; onBrandRules(): void;
};
const button = "rounded-full border border-border bg-card px-3 py-2 text-xs disabled:opacity-40";

/** A view of the saved canvas and trusted project materials, never another
 * canvas store. Source links come from the existing persisted image metadata. */
export function OwnedProjectSidebar(props: Props) {
  const [tab, setTab] = useState<"canvas" | "materials">("canvas");
  const [busy, setBusy] = useState(false);
  const flags = getSceneFlags(props.document?.items ?? []);
  const images = props.document?.items.filter(item => item.kind === "image" && !flags.get(item.id)?.hidden) ?? [];
  async function perform(action: () => void | Promise<void>) {
    if (busy) return; setBusy(true);
    try { await action(); } catch (error) { props.onNotice(error instanceof Error ? error.message : "素材操作未完成，请稍后确认。"); }
    finally { setBusy(false); }
  }
  return <aside aria-label="项目内容" data-testid="owned-project-content" className="absolute inset-y-0 left-0 z-30 flex w-[min(280px,85vw)] shrink-0 flex-col border-r border-border bg-card shadow-lg xl:relative xl:w-64 xl:shadow-none">
    <header className="flex items-center justify-between px-4 py-4"><h2 className="text-sm font-semibold">项目内容</h2><button className={button} aria-label="收起项目内容" onClick={props.onClose}>收起</button></header>
    <div className="mx-4 mb-4 flex rounded-xl bg-muted p-1" role="tablist" aria-label="项目内容分类">{([['canvas','画布'],['materials','素材']] as const).map(([key,label]) => <button key={key} role="tab" aria-selected={tab === key} className={"flex-1 rounded-lg px-3 py-2 text-xs " + (tab === key ? "bg-accent-soft font-semibold text-primary" : "text-muted-foreground")} onClick={() => setTab(key)}>{label}</button>)}</div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
      {tab === "canvas" ? <>
        <p className="rounded-xl bg-accent-soft px-3 py-3 text-xs font-medium">当前画布</p>
        <h3 className="pt-2 text-xs font-semibold">画布图片 · {images.length}</h3>
        {!images.length && <p className="text-xs leading-6 text-muted-foreground">上传或生成的图片会保留在这里。点击图片可定位，并设为下一轮修改对象。</p>}
        {images.map(item => {
          const source = props.document?.items.find(value => value.id === item.sourceShapeId);
          const selected = props.selectedIds.includes(item.id), locked = flags.get(item.id)?.locked;
          return <button key={item.id} data-image-id={item.id} className={"flex w-full items-center gap-3 rounded-2xl border p-2 text-left " + (selected ? "border-primary bg-accent-soft" : "border-border bg-card")} aria-label={`查看${ownedImageName(item)}`} aria-pressed={selected} onClick={() => props.onChooseImage(item.id)}>
            {/* Persisted asset URLs already passed through the canvas codec. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.url} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" loading="lazy" />
            <span className="min-w-0"><strong className="block truncate text-xs">{ownedImageName(item)}</strong><span className="mt-1 block text-xs text-muted-foreground">{locked ? "已锁定 · 仅定位" : source ? `由${ownedImageName(source)}修改` : item.sourceShapeId ? "修改结果 · 原对象已移除" : item.versionId ? "生成结果" : "原始素材"}</span>{selected && <span className="mt-1 block text-xs text-primary">当前选中</span>}</span>
          </button>;
        })}
      </> : <>
        <div className="flex items-center justify-between"><h3 className="text-xs font-semibold">项目素材</h3><button className={button} onClick={props.onOpenLibrary}>品牌素材库</button></div>
        {!props.materials.length && <p className="text-xs leading-6 text-muted-foreground">项目素材会出现在这里，也可以从品牌素材库添加参考。</p>}
        {props.materials.map(material => <article key={material.assetId} className="space-y-2 rounded-2xl border border-border p-2">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={material.url} alt="" className="h-12 w-12 rounded-xl object-cover" loading="lazy" />
            <span className="min-w-0 truncate text-xs">{material.fileName}</span>
          </div>
          <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || props.readOnly} onClick={() => void perform(() => props.onReference(material))}>用作参考</button><button className={button} disabled={busy || props.readOnly} onClick={() => void perform(() => props.onInsert(material))}>加入画布</button></div>
        </article>)}
      </>}
    </div>
    <footer className="space-y-3 border-t border-border p-4"><button className="w-full text-left text-xs text-muted-foreground" onClick={props.onBrandRules}>品牌规则与高级设置 ›</button><button className={button + " w-full"} disabled={props.readOnly || busy} onClick={props.onUpload}>＋ 上传素材</button></footer>
  </aside>;
}
