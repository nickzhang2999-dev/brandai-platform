"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, FieldLabel, StyleTag } from "@brandai/ui";
import type { AdminWork } from "@/lib/admin-workspaces";

/**
 * P3+ · 作品广场 — admin-only gallery across every workspace.
 *
 * The catalog/table view stays at the top of /admin/workspaces; this is a
 * second panel showing the *output* of those workspaces, sorted newest first.
 *
 * Two pieces:
 *   - WorksPlaza      : masonry-ish responsive grid of work cards
 *   - WorkLightbox    : full-screen detail open on image click, with the
 *                       complete applied-rule list rendered alongside the
 *                       large image so the operator can see WHY each work
 *                       looks the way it does (this is the new admin-side
 *                       feature: the original spec only lists per-version
 *                       brand-fit score, not a full applied-rule diff).
 */

const SCENE_LABEL: Record<string, string> = {
  ECOM_MAIN: "电商主图",
  SCENE: "场景图",
  SOCIAL_POSTER: "社媒海报",
  CAMPAIGN_KV: "活动 KV",
  SELLING_POINT: "卖点图",
};

const COMPLIANCE_TONE: Record<
  NonNullable<AdminWork["complianceOverall"]>,
  "pass" | "risk" | "danger"
> = { PASS: "pass", RISK: "risk", FORBIDDEN: "danger" };

const COMPLIANCE_LABEL: Record<
  NonNullable<AdminWork["complianceOverall"]>,
  string
> = { PASS: "通过", RISK: "风险", FORBIDDEN: "违禁" };

const STRENGTH_LABEL: Record<string, string> = {
  STRONG: "强",
  WEAK: "弱",
  FORBIDDEN: "禁",
};

const RULE_TYPE_LABEL: Record<string, string> = {
  color: "色彩",
  font: "字体",
  layout: "版式",
  imagery: "影像",
  copy: "文案",
  logo: "Logo",
};

function strengthTone(s: string): "strong" | "weak" | "danger" {
  if (s === "STRONG") return "strong";
  if (s === "FORBIDDEN") return "danger";
  return "weak";
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10) + " · " + iso.slice(11, 16);
}

export function WorksPlaza({ works }: { works: AdminWork[] }) {
  const [active, setActive] = useState<AdminWork | null>(null);

  if (works.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-foreground/15 bg-card/50 px-6 py-14 text-center">
        <FieldLabel className="text-accent">GALLERY · 作品广场</FieldLabel>
        <p className="mt-3 font-serif text-lg text-foreground/80">
          暂无任何生成版本
        </p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          任意空间出图后,会按时间倒序汇集到这里。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {works.map((w) => (
          <WorkCard key={w.versionId} work={w} onOpen={() => setActive(w)} />
        ))}
      </div>
      {active ? (
        <WorkLightbox work={active} onClose={() => setActive(null)} />
      ) : null}
    </>
  );
}

function WorkCard({
  work,
  onOpen,
}: {
  work: AdminWork;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-3 text-left transition"
    >
      <div
        className={
          "relative aspect-square overflow-hidden rounded-2xl border bg-muted shadow-[0_1px_0_0_rgb(0_0_0/0.04)] transition-shadow group-hover:shadow-md " +
          (work.isFinal
            ? "border-accent ring-2 ring-accent"
            : "border-foreground/10")
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={work.imageUrl}
          alt={`${work.workspaceName} · ${work.projectName} · v${work.index}`}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">
          {work.isFinal ? (
            <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink shadow-sm">
              最终版
            </span>
          ) : null}
          {work.parentVersionId ? (
            <span className="rounded-full bg-background/85 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-foreground/70 backdrop-blur-sm">
              编辑衍生
            </span>
          ) : null}
        </div>
        {work.complianceOverall ? (
          <div className="absolute right-2 top-2">
            <Badge
              tone={COMPLIANCE_TONE[work.complianceOverall]}
              className="font-mono text-[10px]"
            >
              {COMPLIANCE_LABEL[work.complianceOverall]}
            </Badge>
          </div>
        ) : null}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-foreground/70 via-foreground/40 to-transparent p-3 text-background opacity-0 transition-opacity group-hover:opacity-100">
          <p className="line-clamp-2 text-xs">
            {work.sellingPoint || work.scene}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-serif text-sm text-foreground">
            {work.projectName}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            v{work.index}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <StyleTag className="!px-2 !py-0.5 !text-[10px]">
            {SCENE_LABEL[work.sceneType] ?? work.sceneType}
          </StyleTag>
          <span className="truncate text-[11px] text-muted-foreground">
            {work.workspaceName}
          </span>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {fmtDate(work.createdAt)}
        </div>
      </div>
    </button>
  );
}

function WorkLightbox({
  work,
  onClose,
}: {
  work: AdminWork;
  onClose: () => void;
}) {
  // Esc closes; lock body scroll while the lightbox is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="作品详情"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-foreground/70 p-4 backdrop-blur-sm md:p-8"
      onClick={onClose}
    >
      <div
        className="relative grid w-full max-w-7xl grid-cols-1 gap-0 overflow-hidden rounded-3xl bg-background shadow-2xl lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-4 top-4 z-10 rounded-full border border-foreground/10 bg-background/85 px-3 py-1 font-mono text-xs uppercase tracking-wide text-foreground/70 backdrop-blur-sm transition hover:bg-background"
        >
          ESC · 关闭
        </button>

        {/* Large image */}
        <div className="flex items-center justify-center bg-muted/40 p-6 md:p-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={work.imageUrl}
            alt={`${work.projectName} · v${work.index}`}
            className="max-h-[80vh] w-auto max-w-full rounded-2xl border border-foreground/10 bg-card object-contain shadow-md"
          />
        </div>

        {/* Details — workspace, generation, applied rules */}
        <div className="flex max-h-[88vh] flex-col gap-5 overflow-y-auto border-t border-foreground/10 bg-card p-6 md:p-8 lg:border-l lg:border-t-0">
          <div className="flex flex-col gap-1">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">
              GALLERY · 作品详情
            </div>
            <h2 className="font-serif text-2xl text-foreground">
              {work.projectName}
            </h2>
            <div className="flex flex-wrap items-baseline gap-2 text-sm text-muted-foreground">
              <span className="font-mono">
                v{work.index} · {work.width}×{work.height}
              </span>
              <span aria-hidden>·</span>
              <Link
                href={`/admin/workspaces/${work.workspaceId}`}
                className="underline-offset-2 hover:underline"
              >
                {work.workspaceName}
              </Link>
              <span aria-hidden>·</span>
              <span>{work.ownerEmail}</span>
            </div>
            <div className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              {fmtDate(work.createdAt)}
            </div>
          </div>

          {/* Status badges */}
          <div className="flex flex-wrap gap-2">
            <StyleTag>
              {SCENE_LABEL[work.sceneType] ?? work.sceneType}
            </StyleTag>
            {work.campaign ? <StyleTag>活动 · {work.campaign}</StyleTag> : null}
            {work.isFinal ? <Badge tone="pass">最终版</Badge> : null}
            {work.parentVersionId ? <Badge tone="neutral">编辑衍生</Badge> : null}
            {work.complianceOverall ? (
              <Badge tone={COMPLIANCE_TONE[work.complianceOverall]}>
                合规 · {COMPLIANCE_LABEL[work.complianceOverall]}
              </Badge>
            ) : null}
            {work.complianceScore != null ? (
              <Badge tone="neutral">
                品牌契合 {work.complianceScore}
              </Badge>
            ) : null}
            <Badge tone="weak">{work.reviewStatus}</Badge>
          </div>

          {/* Brief */}
          <section className="flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-background p-4">
            <FieldLabel>BRIEF · 创意简报</FieldLabel>
            <div className="flex flex-col gap-1.5 text-sm">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  卖点
                </span>
                <div className="text-foreground">
                  {work.sellingPoint || "—"}
                </div>
              </div>
              <div>
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  场景
                </span>
                <div className="text-foreground">{work.scene || "—"}</div>
              </div>
            </div>
          </section>

          {/* Applied rules — the new admin feature: SEE every rule that
              shaped this output. Groups by RuleType for scanability. */}
          <section className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-background p-4">
            <div className="flex items-baseline justify-between gap-3">
              <FieldLabel>APPLIED RULES · 受控规则</FieldLabel>
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {work.appliedRules.length} 条
              </span>
            </div>
            {work.appliedRules.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                该版本生成时未引用任何 CONFIRMED 规则(可能是早期版本或编辑衍生)。
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {work.appliedRules.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-start gap-2 rounded-xl border border-foreground/10 bg-card/60 px-3 py-2 text-xs"
                  >
                    <Badge tone={strengthTone(r.strength)}>
                      {STRENGTH_LABEL[r.strength] ?? r.strength}
                    </Badge>
                    <div className="flex flex-1 flex-col gap-0.5">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                        {RULE_TYPE_LABEL[r.type] ?? r.type}
                      </span>
                      <span className="leading-relaxed text-foreground/85">
                        {r.summary}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Drill-down link */}
          <div className="mt-auto flex flex-wrap items-center gap-3 pt-2">
            <Link
              href={`/admin/workspaces/${work.workspaceId}`}
              className="rounded-full border border-foreground/15 px-4 py-1.5 font-mono text-xs uppercase tracking-wide text-foreground/70 transition hover:border-accent hover:text-foreground"
            >
              空间详情 →
            </Link>
            <a
              href={work.imageUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-foreground/15 px-4 py-1.5 font-mono text-xs uppercase tracking-wide text-foreground/70 transition hover:border-accent hover:text-foreground"
            >
              原图 ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
