"use client";

import { useCallback, useState } from "react";
import type {
  BrandRule,
  Project,
  RecognizeResponse,
  WorkspaceRole,
} from "@brandai/contracts";
import { GenerateWizard } from "./generate-wizard";
import { CampaignKit } from "./campaign-kit";
import { BrandSystemSidebar } from "./brand-system-sidebar";
import { RuleConstraintsSidebar } from "./rule-constraints-sidebar";

type Mode = "single" | "campaign";
type ColorSystem = NonNullable<RecognizeResponse["colorSystem"]>;

/**
 * M3 / E8 — mode switch over the generation surface.
 *
 * P3.3 — single mode is now wrapped in the §6.4 3-column layout:
 *   left:  BrandSystemSidebar   — live VI summary (colors / rules by type)
 *   center: GenerateWizard       — existing step flow, untouched
 *   right: RuleConstraintsSidebar — confirmed rules with strength badges
 *
 * Campaign Kit keeps the full-width layout (it already drives a wider
 * multi-scene × multi-channel grid that benefits from breathing room).
 */
export function GenerateModes({
  wsId,
  initialProjects,
  confirmedRules,
  colorSystem,
  myRole,
}: {
  wsId: string;
  initialProjects: Project[];
  confirmedRules: BrandRule[];
  colorSystem: ColorSystem | null;
  myRole: WorkspaceRole;
}) {
  const [mode, setMode] = useState<Mode>("single");
  // P3.3 — lifted brief text so the right rail can highlight matching rules
  // in real time. `useCallback` keeps the wizard's useEffect identity stable.
  const [brief, setBrief] = useState({ sellingPoint: "", scene: "" });
  const onBriefChange = useCallback(
    (b: { sellingPoint: string; scene: string }) => setBrief(b),
    [],
  );
  const tabs: { value: Mode; label: string }[] = [
    { value: "single", label: "单次生成" },
    { value: "campaign", label: "Campaign Kit · 活动物料包" },
  ];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => {
          const active = mode === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setMode(t.value)}
              className={`rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-[0.15em] transition-colors ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-foreground/15 text-foreground/70 hover:bg-muted"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {mode === "single" ? (
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)_20rem]">
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <BrandSystemSidebar
              rules={confirmedRules}
              colorSystem={colorSystem}
              briefText={`${brief.sellingPoint} ${brief.scene}`}
            />
          </aside>
          <div className="min-w-0">
            <GenerateWizard
              wsId={wsId}
              initialProjects={initialProjects}
              confirmedRuleCount={confirmedRules.length}
              confirmedRules={confirmedRules}
              myRole={myRole}
              onBriefChange={onBriefChange}
            />
          </div>
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <RuleConstraintsSidebar
              rules={confirmedRules}
              briefText={`${brief.sellingPoint} ${brief.scene}`}
            />
          </aside>
        </div>
      ) : (
        <CampaignKit
          wsId={wsId}
          initialProjects={initialProjects}
          confirmedRuleCount={confirmedRules.length}
        />
      )}
    </div>
  );
}
