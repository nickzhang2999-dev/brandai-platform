"use client";

import type {
  ComplianceLevel,
  ComplianceReport,
  ComplianceResult,
} from "@brandai/contracts";
import { Badge, FieldLabel } from "@brandai/ui";

/**
 * M5 · 校验报告 UI — reusable 通过 / 风险 / 建议 view.
 *
 * Renders an overall verdict plus per-result reason / 替代表达 / category,
 * split into text findings and image-level (VLM) findings. Used by:
 *  - the workspace 合规校验 page (paste-copy precheck preview), and
 *  - a finalized GenerationVersion's stored `complianceReport`.
 */

const LEVEL_TONE: Record<ComplianceLevel, "pass" | "risk" | "danger"> = {
  PASS: "pass",
  RISK: "risk",
  FORBIDDEN: "danger",
};

const LEVEL_LABEL: Record<ComplianceLevel, string> = {
  PASS: "通过",
  RISK: "风险",
  FORBIDDEN: "违禁",
};

const CATEGORY_LABEL: Record<string, string> = {
  ABSOLUTE: "绝对化用语",
  EFFICACY: "功效承诺",
  EXAGGERATION: "夸大收益",
  AUTHORITY: "权威背书",
  BRAND_TERM: "品牌词库",
  BRAND_VISUAL: "品牌视觉",
  PLATFORM: "平台规范",
};

function ResultRow({ r }: { r: ComplianceResult }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-2xl border border-foreground/10 bg-muted px-5 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={LEVEL_TONE[r.level]}>{LEVEL_LABEL[r.level]}</Badge>
        {r.category ? (
          <Badge tone="weak">
            {CATEGORY_LABEL[r.category] ?? r.category}
          </Badge>
        ) : null}
        {r.span ? (
          <span className="font-serif text-foreground">「{r.span}」</span>
        ) : null}
      </div>
      <p className="text-muted-foreground">{r.reason}</p>
      {r.replacement ? (
        <p className="text-accent">
          建议替换：<span className="text-foreground">{r.replacement}</span>
        </p>
      ) : null}
    </li>
  );
}

function ResultGroup({
  title,
  results,
  emptyHint,
}: {
  title: string;
  results: ComplianceResult[];
  emptyHint: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <FieldLabel>{title}</FieldLabel>
        <span className="font-mono text-xs text-muted-foreground">
          {results.length}
        </span>
      </div>
      {results.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {results.map((r, i) => (
            <ResultRow key={`${title}-${i}`} r={r} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      )}
    </div>
  );
}

export function ComplianceReportView({
  report,
  className,
}: {
  report: ComplianceReport;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-foreground/10 bg-card p-6 shadow-sm md:p-7 ${
        className ?? ""
      }`}
    >
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-2">
          <FieldLabel>COMPLIANCE · 校验报告</FieldLabel>
          <div className="flex items-center gap-3">
            <span className="font-serif text-2xl">总体结论</span>
            <Badge tone={LEVEL_TONE[report.overall]}>
              {LEVEL_LABEL[report.overall]}
            </Badge>
          </div>
        </div>
        {report.checkedAt ? (
          <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {new Date(report.checkedAt).toLocaleString("zh-CN")}
          </span>
        ) : null}
      </div>
      <div className="grid gap-7 lg:grid-cols-2">
        <ResultGroup
          title="文案合规 · TEXT"
          results={report.textResults}
          emptyHint="未发现文案风险。"
        />
        <ResultGroup
          title="图片层校验 · VISUAL（Logo / 主色 / 禁用元素 / 产品变形）"
          results={report.visualResults}
          emptyHint="无图片校验项。"
        />
      </div>
    </div>
  );
}
