"use client";

import { useMemo } from "react";
import type { BrandRule, RuleStrength } from "@brandai/contracts";
import {
  Badge,
  FieldLabel,
  Panel,
  SectionHeading,
} from "@brandai/ui";
import { tokensFrom, summaryMatchesTokens } from "./brief-tokens";

/**
 * P3.3 · Rule Constraints Sidebar — right rail of the §6.4 generation
 * workspace. Lists every confirmed rule that will be compiled into the
 * prompt, grouped by type. Strength badges show which rules are STRONG
 * (hard) vs WEAK (soft) constraints.
 *
 * Real-time hit highlighting: `briefText` (selling point + scene from
 * the wizard) is keyword-scanned against each rule's summary. When a
 * shared lexical token shows up, that rule is flagged 「命中」 with an
 * accent border + dot. Pure client-side, no AI; the goal is to give
 * the user confidence the rule library is *actually* steering the
 * pitch they're writing.
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

function strengthTone(s: RuleStrength): "strong" | "weak" | "danger" {
  if (s === "STRONG") return "strong";
  if (s === "FORBIDDEN") return "danger";
  return "weak";
}

function strengthLabel(s: RuleStrength): string {
  if (s === "STRONG") return "强";
  if (s === "FORBIDDEN") return "禁";
  return "弱";
}

function ruleIsHit(rule: BrandRule, tokens: string[]): boolean {
  return summaryMatchesTokens(rule.summary, tokens);
}

export function RuleConstraintsSidebar({
  rules,
  briefText = "",
}: {
  rules: BrandRule[];
  briefText?: string;
}) {
  const tokens = useMemo(() => tokensFrom(briefText), [briefText]);

  const { byType, hitCount } = useMemo(() => {
    const m = new Map<string, BrandRule[]>();
    let hits = 0;
    for (const r of rules) {
      const k = (r.type as string) ?? "other";
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
      if (ruleIsHit(r, tokens)) hits++;
    }
    return { byType: m, hitCount: hits };
  }, [rules, tokens]);

  const typeKeys = [...byType.keys()].sort();

  return (
    <Panel className="flex flex-col gap-5">
      <SectionHeading
        eyebrow={`CONSTRAINTS · ${rules.length} 条`}
        title="规则约束"
        action={
          tokens.length > 0 ? (
            <Badge tone={hitCount > 0 ? "strong" : "neutral"}>
              {hitCount > 0 ? `${hitCount} 命中` : "未命中"}
            </Badge>
          ) : null
        }
      />
      <p className="text-xs text-muted-foreground">
        生成时这些规则会拼入 prompt;STRONG 走硬约束,WEAK 走偏好,FORBIDDEN
        走 negative_prompt。
        {tokens.length > 0
          ? "  · 与卖点/场景文本共词的条目高亮为「命中」。"
          : null}
      </p>

      {rules.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-muted/40 px-4 py-6 text-center text-xs text-muted-foreground">
          尚无已确认规则。
          <br />
          先到「风格规则」页确认规则,才会受控生成。
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {typeKeys.map((t) => (
            <div key={t} className="flex flex-col gap-2">
              <FieldLabel>{TYPE_LABEL[t] ?? t}</FieldLabel>
              <ul className="flex flex-col gap-2">
                {byType.get(t)!.map((r) => {
                  const hit = ruleIsHit(r, tokens);
                  return (
                    <li
                      key={r.id}
                      aria-label={hit ? "命中规则" : undefined}
                      className={
                        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs transition-colors " +
                        (hit
                          ? "border-accent bg-accent/10 ring-1 ring-accent"
                          : "border-foreground/10 bg-card/60")
                      }
                    >
                      <Badge tone={strengthTone(r.strength)}>
                        {strengthLabel(r.strength)}
                      </Badge>
                      <span className="flex-1 leading-relaxed text-foreground/80">
                        {r.summary}
                      </span>
                      {hit ? (
                        <span
                          aria-hidden
                          className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                          title="brief 命中"
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
