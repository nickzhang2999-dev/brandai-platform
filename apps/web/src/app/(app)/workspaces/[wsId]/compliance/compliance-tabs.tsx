"use client";

import { useState } from "react";
import { ComplianceTermEntry } from "./compliance-term-entry";
import { ProhibitionRuleEntry } from "./prohibition-rule-entry";
import { TextChecker } from "./text-checker";

type Tab = "rules" | "terms" | "checker";

const TABS: { id: Tab; label: string }[] = [
  { id: "rules", label: "禁用规范（规则级）" },
  { id: "terms", label: "禁用 / 慎用词（词级）" },
  { id: "checker", label: "文案预检" },
];

/**
 * Compliance hub (P1.1) — three sibling tabs:
 *   - rules    : ProhibitionRule (规则级禁用规范, P1.1 新增)
 *   - terms    : ComplianceTerm  (词级 禁用/慎用词)
 *   - checker  : 广告法 / 文案预检
 */
export function ComplianceTabs({ wsId }: { wsId: string }) {
  const [tab, setTab] = useState<Tab>("rules");
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
                active
                  ? "border-foreground/15 bg-primary text-primary-foreground"
                  : "border-foreground/15 bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === "rules" ? <ProhibitionRuleEntry wsId={wsId} /> : null}
      {tab === "terms" ? (
        <section className="flex flex-col gap-6">
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            禁用词命中判为
            <span className="text-destructive">违禁（FORBIDDEN）</span>，
            慎用词命中判为<span className="text-accent">风险（RISK）</span>。
            词库会注入生成前预检与生成后复检。
          </p>
          <ComplianceTermEntry wsId={wsId} />
        </section>
      ) : null}
      {tab === "checker" ? <TextChecker wsId={wsId} /> : null}
    </div>
  );
}
