"use client";

import { useMemo } from "react";
import type {
  ComplianceLevel,
  ComplianceReport,
  GenerationVersion,
} from "@brandai/contracts";
import {
  Button,
  Badge,
  Panel,
  SectionHeading,
  FieldLabel,
  VersionCompareView,
} from "@brandai/ui";

/**
 * M6 · 版本对比 — side-by-side image + a structured diff of `params` and
 * the stored `complianceReport` (overall verdict + per-list result
 * counts by level). Pure read of two contract-shaped GenerationVersions;
 * no mutation. Highlights keys that differ between A and B.
 */

const LEVEL_LABEL: Record<ComplianceLevel, string> = {
  PASS: "通过",
  RISK: "风险",
  FORBIDDEN: "违禁",
};
const LEVEL_TONE: Record<ComplianceLevel, "pass" | "risk" | "danger"> = {
  PASS: "pass",
  RISK: "risk",
  FORBIDDEN: "danger",
};

function flat(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flat(v as Record<string, unknown>, key));
    } else {
      out[key] = JSON.stringify(v);
    }
  }
  return out;
}

function reportSummary(r?: ComplianceReport) {
  if (!r) return null;
  const count = (lvl: ComplianceLevel) =>
    [...r.textResults, ...r.visualResults].filter(
      (x) => x.level === lvl,
    ).length;
  return {
    overall: r.overall,
    PASS: count("PASS"),
    RISK: count("RISK"),
    FORBIDDEN: count("FORBIDDEN"),
  };
}

export function VersionCompare({
  a,
  b,
  onClose,
}: {
  a: GenerationVersion;
  b: GenerationVersion;
  onClose: () => void;
}) {
  const { keys, fa, fb, diffCount } = useMemo(() => {
    const fa = flat(a.params as Record<string, unknown>);
    const fb = flat(b.params as Record<string, unknown>);
    const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
      .sort();
    const diffCount = keys.filter((k) => (fa[k] ?? "—") !== (fb[k] ?? "—"))
      .length;
    return { keys, fa, fb, diffCount };
  }, [a, b]);

  const ra = reportSummary(a.complianceReport);
  const rb = reportSummary(b.complianceReport);

  return (
    <Panel className="flex flex-col gap-7 border-accent ring-1 ring-accent/40">
      <SectionHeading
        eyebrow="COMPARE · 版本对比"
        title={`v${a.index} ↔ v${b.index}`}
        action={
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        }
      />

      <VersionCompareView
        left={{
          label: `v${a.index}${a.isFinal ? " · 最终版" : ""}`,
          imageUrl: a.imageUrl,
          caption: `${a.width}×${a.height}`,
        }}
        right={{
          label: `v${b.index}${b.isFinal ? " · 最终版" : ""}`,
          imageUrl: b.imageUrl,
          caption: `${b.width}×${b.height}`,
        }}
      />

      <div className="flex flex-col gap-3">
        <FieldLabel>合规差异 · 总体 / 各等级计数</FieldLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { label: `v${a.index}`, s: ra },
            { label: `v${b.index}`, s: rb },
          ].map(({ label, s }) => (
            <div
              key={label}
              className="flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-muted px-5 py-4"
            >
              <span className="font-mono text-xs uppercase tracking-wide text-foreground">
                {label}
              </span>
              {s ? (
                <span className="flex flex-wrap gap-2">
                  <Badge tone={LEVEL_TONE[s.overall]}>
                    总体：{LEVEL_LABEL[s.overall]}
                  </Badge>
                  <Badge tone="pass">通过 {s.PASS}</Badge>
                  <Badge tone="risk">风险 {s.RISK}</Badge>
                  <Badge tone="danger">违禁 {s.FORBIDDEN}</Badge>
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">无报告</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <FieldLabel>参数 diff · PARAMS</FieldLabel>
          <Badge tone={diffCount > 0 ? "risk" : "neutral"}>
            {diffCount > 0
              ? `${diffCount} 处差异 / 共 ${keys.length} 项`
              : `${keys.length} 项 · 完全一致`}
          </Badge>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-foreground/10">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted font-mono uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">参数</th>
                <th className="px-4 py-3">v{a.index}</th>
                <th className="px-4 py-3">v{b.index}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const va = fa[k] ?? "—";
                const vb = fb[k] ?? "—";
                const diff = va !== vb;
                return (
                  <tr
                    key={k}
                    className={
                      diff
                        ? "border-t border-accent/30 bg-accent/10"
                        : "border-t border-foreground/10"
                    }
                  >
                    <td className="px-4 py-2.5 font-mono text-foreground/70">
                      {diff ? (
                        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />
                      ) : null}
                      {k}
                    </td>
                    <td className="px-4 py-2.5 font-mono">{va}</td>
                    <td className="px-4 py-2.5 font-mono">{vb}</td>
                  </tr>
                );
              })}
              {keys.length === 0 ? (
                <tr>
                  <td
                    className="px-4 py-3 text-muted-foreground"
                    colSpan={3}
                  >
                    无参数可对比。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}
