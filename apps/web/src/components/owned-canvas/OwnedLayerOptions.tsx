"use client";

import { useId } from "react";
import type { OwnedLayerMode } from "./owned-layer-options";

type Props = { mode: OwnedLayerMode; count: number; disabled: boolean; context: "PSD" | "分层";
  onMode(mode: OwnedLayerMode): void; onCount(count: number): void };
const control = "rounded-full border border-border bg-card px-3 py-2 text-xs text-fg disabled:opacity-40";

/** Automatic planning is the ordinary flow. Manual legacy counts stay
 * explicit and reachable, without making every user guess an element count. */
export function OwnedLayerOptions({ mode, count, disabled, context, onMode, onCount }: Props) {
  const id = useId();
  return <div className="space-y-2" data-testid={context === "PSD" ? "owned-psd-layer-options" : "owned-layer-options"}>
    <p className="text-xs leading-5 text-muted-fg">{mode === "AUTO" ? "按内容自动拆分，无需指定层数。" : `手动指定 ${count} 层。`}</p>
    <details className="rounded-xl border border-border bg-card px-3 py-2" open={mode === "MANUAL" ? true : undefined}>
      <summary className="cursor-pointer text-xs text-muted-fg">高级分层设置</summary>
      <fieldset className="mt-3 space-y-3" disabled={disabled}>
        <legend className="sr-only">{context}拆分方式</legend>
        <label className="flex items-center gap-2 text-xs"><input type="radio" name={id} value="AUTO" checked={mode === "AUTO"} onChange={() => onMode("AUTO")} className="h-4 w-4 accent-primary" />自动按内容拆分</label>
        <label className="flex items-center gap-2 text-xs"><input type="radio" name={id} value="MANUAL" checked={mode === "MANUAL"} onChange={() => onMode("MANUAL")} className="h-4 w-4 accent-primary" />手动指定层数</label>
        {mode === "MANUAL" && <label className="flex flex-wrap items-center gap-2 text-xs text-muted-fg">层数<select aria-label={context === "PSD" ? "PSD图层数量" : "拆分层数"} className={control} value={count} onChange={event => onCount(Number(event.target.value))}>{Array.from({ length: 9 }, (_, index) => index + 2).map(value => <option key={value} value={value}>{value} 层</option>)}</select></label>}
      </fieldset>
    </details>
  </div>;
}
