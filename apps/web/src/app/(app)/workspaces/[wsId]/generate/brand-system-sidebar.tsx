"use client";

import { useMemo } from "react";
import type { BrandRule, RecognizeResponse } from "@brandai/contracts";
import {
  BrandDNAPanel,
  ColorSwatch,
  FieldLabel,
  StyleTag,
  MiniStat,
} from "@brandai/ui";
import { tokensFrom, summaryMatchesTokens } from "./brief-tokens";

type ColorSystem = NonNullable<RecognizeResponse["colorSystem"]>;

/**
 * P3.3 · Brand System Sidebar — left rail of the §6.4 generation workspace.
 * Surfaces a live read-only summary of the brand DNA that the generator
 * compiles into the prompt: Color System palette + per-type rule chips.
 *
 * When `briefText` is non-empty the per-type "hits / total" count appears,
 * so the user sees at a glance which DNA axes their pitch is engaging.
 */
const TYPE_LABEL: Record<string, string> = {
  color: "色彩",
  font: "字体",
  layout: "版式",
  imagery: "影像",
  graphic: "图形",
  copy: "文案",
  logo: "Logo",
};

const TYPE_ORDER = [
  "color",
  "font",
  "layout",
  "imagery",
  "graphic",
  "copy",
  "logo",
];

export function BrandSystemSidebar({
  rules,
  colorSystem,
  briefText = "",
}: {
  rules: BrandRule[];
  colorSystem: ColorSystem | null;
  briefText?: string;
}) {
  const tokens = useMemo(() => tokensFrom(briefText), [briefText]);

  // Keyed on `rules` only — `briefText` changes every keystroke but the
  // type-grouping doesn't depend on it, so rebuilding the Map per keystroke
  // was pure waste.
  const byType = useMemo(() => {
    const m = new Map<string, BrandRule[]>();
    for (const r of rules) {
      const k = (r.type as string) ?? "other";
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return m;
  }, [rules]);

  const totalHits = useMemo(
    () => rules.filter((r) => summaryMatchesTokens(r.summary, tokens)).length,
    [rules, tokens],
  );

  return (
    <BrandDNAPanel
      title="Brand DNA · 受控参数"
      subtitle="生成时自动拼入 prompt 的已确认规则与色系"
    >
      <div className="flex flex-wrap gap-4">
        <MiniStat
          label="CONFIRMED"
          value={rules.length}
          hint="已确认规则总数"
        />
        {tokens.length > 0 ? (
          <MiniStat
            label="MATCHED"
            value={totalHits}
            hint="与当前 brief 共词"
          />
        ) : null}
      </div>

      {colorSystem ? (
        <div className="flex flex-col gap-2">
          <FieldLabel>调色板 · PALETTE</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {colorSystem.palette.slice(0, 6).map((c: string, i: number) => (
              <ColorSwatch key={`p-${i}`} hex={c} />
            ))}
            {colorSystem.palette.length === 0 ? (
              <span className="text-xs text-muted-foreground">未识别</span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>对比度 {colorSystem.contrastScore}</span>
            <span>一致性 {colorSystem.consistencyScore}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          尚未识别 Color System — 在「风格规则」页选素材发起识别。
        </p>
      )}

      <div className="flex flex-col gap-3">
        <FieldLabel>规则 · BY TYPE</FieldLabel>
        {TYPE_ORDER.map((t) => {
          const items = byType.get(t) ?? [];
          const hits = items.filter((r) => summaryMatchesTokens(r.summary, tokens)).length;
          return (
            <div key={t} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="font-serif text-sm text-foreground">
                  {TYPE_LABEL[t]}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {tokens.length > 0 && items.length > 0
                    ? `${hits} / ${items.length} 命中`
                    : `${items.length} 条`}
                </span>
              </div>
              {items.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {items.slice(0, 5).map((r) => {
                    const hit = summaryMatchesTokens(r.summary, tokens);
                    return (
                      <span
                        key={r.id}
                        title={r.summary}
                        className={
                          hit
                            ? "rounded-full ring-1 ring-accent"
                            : undefined
                        }
                      >
                        <StyleTag>{truncate(r.summary, 14)}</StyleTag>
                      </span>
                    );
                  })}
                  {items.length > 5 ? (
                    <span className="text-[11px] text-muted-foreground">
                      +{items.length - 5}
                    </span>
                  ) : null}
                </div>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  ——
                </span>
              )}
            </div>
          );
        })}
      </div>
    </BrandDNAPanel>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
