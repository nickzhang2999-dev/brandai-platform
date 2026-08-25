"use client";

import { useCallback, useEffect, useState } from "react";
import type { LayerSetView } from "@brandai/contracts";
import {
  canExportFlattened,
  canExportLayeredDocument,
  isEmptyCoverage,
} from "@brandai/contracts";
import { apiFetch } from "@/lib/client";

/**
 * 图层面板 —— 一组分解产物的显隐 / 不透明度 / 层序 / 导出。
 *
 * 所有状态都是**服务端权威**:改一下就 PATCH 回去，刷新、换设备、分享读到的是
 * 同一份。prd_agent 把这些放在画布本地，于是出现过「面板里调过层序，导出的文档
 * 却按另一个顺序排」——两个口径漂移。
 */
export function LayerPanel({
  wsId,
  generationId,
  setId,
  onClose,
  onChanged,
}: {
  wsId: string;
  generationId: string;
  setId: string;
  onClose: () => void;
  /** 面板改完之后让画布重新拉一次版本（显隐/层序要立刻反映到画布上）。 */
  onChanged: () => void;
}) {
  const [view, setView] = useState<LayerSetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = `/api/workspaces/${wsId}/generations/${generationId}/layer-sets/${setId}`;

  const load = useCallback(async () => {
    try {
      setView(await apiFetch<LayerSetView>(base));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取图层组失败");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (
      layers: {
        versionId: string;
        hidden?: boolean;
        opacity?: number;
        z?: number;
      }[],
    ) => {
      setBusy(true);
      try {
        setView(
          await apiFetch<LayerSetView>(base, {
            method: "PATCH",
            body: JSON.stringify({ layers }),
          }),
        );
        setError(null);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存失败");
      } finally {
        setBusy(false);
      }
    },
    [base, onChanged],
  );

  const move = (versionId: string, dir: -1 | 1) => {
    if (!view) return;
    const ordered = [...view.layers];
    const at = ordered.findIndex((l) => l.versionId === versionId);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= ordered.length) return;
    const [moved] = ordered.splice(at, 1);
    ordered.splice(to, 0, moved!);
    // 重排后按位置重新发号:层序是连续整数,不靠数组序隐式表达。
    void patch(ordered.map((l, i) => ({ versionId: l.versionId, z: i })));
  };

  const layers = view?.layers ?? [];
  const canPsd = canExportLayeredDocument(layers);
  const canFlat = canExportFlattened(layers);

  return (
    <div
      data-testid="layer-panel"
      className="absolute bottom-4 left-4 z-30 w-[340px] rounded-2xl border border-border bg-background/95 p-3 shadow-[0_18px_48px_rgba(124,92,255,0.18)] backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            图层 · {layers.length} 层
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {view?.intent ? `拆法：${view.intent}` : "未指定拆法"}
            {view?.seed !== undefined ? ` · seed ${view.seed}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
        >
          收起
        </button>
      </div>

      {error ? (
        <p className="mt-2 rounded-lg bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      <ul className="mt-2 flex max-h-[42vh] flex-col gap-1 overflow-y-auto">
        {layers.map((layer, i) => (
          <li
            key={layer.versionId}
            data-testid="layer-row"
            data-hidden={layer.hidden ? "1" : "0"}
            className="flex items-center gap-2 rounded-lg border border-border/60 px-2 py-1.5"
          >
            <button
              type="button"
              aria-label={layer.hidden ? "显示该图层" : "隐藏该图层"}
              disabled={busy}
              onClick={() =>
                void patch([
                  { versionId: layer.versionId, hidden: !layer.hidden },
                ])
              }
              className="h-6 w-6 shrink-0 rounded border border-border text-[11px] text-muted-foreground disabled:opacity-40"
            >
              {layer.hidden ? "隐" : "显"}
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={layer.imageUrl}
              alt={`图层 ${i + 1}`}
              className="h-8 w-8 shrink-0 rounded object-contain"
              style={{ background: "rgb(244 240 255 / 0.6)" }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-foreground">
                第 {layer.index + 1} 层
                {isEmptyCoverage(layer.inkCoverage) ? (
                  <span
                    data-testid="layer-empty-badge"
                    title="这一层上游没给内容（多半是层数要得比画面里的元素还多）。它不会被自动隐藏——你可以自己关掉，或把层数调小重拆一次。"
                    className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                  >
                    空
                  </span>
                ) : null}
                {layer.thin ? (
                  <span
                    data-testid="layer-thin-badge"
                    title="很细的一层（描边 / 角标这类）。它是真实内容，不会被自动隐藏。"
                    className="ml-1 rounded bg-accent-soft px-1 text-[10px] text-primary"
                  >
                    细
                  </span>
                ) : null}
              </div>
              <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                覆盖 {(layer.inkCoverage * 100).toFixed(2)}%
                {layer.bounds
                  ? ` · ${layer.bounds.width}×${layer.bounds.height}`
                  : ""}
              </div>
            </div>
            <input
              type="range"
              aria-label="不透明度"
              min={0}
              max={100}
              value={Math.round(layer.opacity * 100)}
              disabled={busy}
              onChange={(e) =>
                void patch([
                  {
                    versionId: layer.versionId,
                    opacity: Number(e.target.value) / 100,
                  },
                ])
              }
              className="w-14 shrink-0 accent-primary"
            />
            <span className="flex shrink-0 flex-col">
              <button
                type="button"
                aria-label="上移一层"
                disabled={busy || i === layers.length - 1}
                onClick={() => move(layer.versionId, 1)}
                className="h-3.5 w-5 rounded-t border border-border text-[9px] leading-none text-muted-foreground disabled:opacity-30"
              >
                ▲
              </button>
              <button
                type="button"
                aria-label="下移一层"
                disabled={busy || i === 0}
                onClick={() => move(layer.versionId, -1)}
                className="h-3.5 w-5 rounded-b border border-t-0 border-border text-[9px] leading-none text-muted-foreground disabled:opacity-30"
              >
                ▼
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-center gap-1.5">
        {/* PSD 只要「有产物」就能导出：分层文档有意保留隐藏层（写进去并标隐藏），
            所以「全部隐藏」是合法状态，此时它是唯一仍然成立的那个出口。 */}
        <a
          href={`${base}/export?format=psd`}
          aria-disabled={!canPsd}
          data-testid="export-psd"
          className={[
            "rounded-lg px-2.5 py-1 text-xs font-medium",
            canPsd
              ? "bg-gradient-to-br from-primary to-accent text-primary-foreground"
              : "pointer-events-none border border-border text-muted-foreground opacity-40",
          ].join(" ")}
        >
          导出 PSD
        </a>
        <a
          href={`${base}/export?format=zip`}
          aria-disabled={!canFlat}
          className={[
            "rounded-lg border px-2.5 py-1 text-xs",
            canFlat
              ? "border-border text-muted-foreground hover:bg-muted"
              : "pointer-events-none border-border text-muted-foreground opacity-40",
          ].join(" ")}
        >
          打包 ZIP
        </a>
        <a
          href={`${base}/export?format=png`}
          aria-disabled={!canFlat}
          className={[
            "rounded-lg border px-2.5 py-1 text-xs",
            canFlat
              ? "border-border text-muted-foreground hover:bg-muted"
              : "pointer-events-none border-border text-muted-foreground opacity-40",
          ].join(" ")}
        >
          合成 PNG
        </a>
      </div>
    </div>
  );
}
