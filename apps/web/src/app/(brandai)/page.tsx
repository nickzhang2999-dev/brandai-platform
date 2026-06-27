"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, TaskState } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import { quickActions } from "@/lib/brandai-mock";
import { useBrand } from "./brand-context";
import { AIInput } from "./ai-input";
import { gradientFor } from "./_ui";
import { RecommendedBrands } from "./recommended-brands";

/**
 * P01 · 首页 — AI 入口 + 近期项目速览。真实数据：当前品牌的 Campaign 列表。
 */
type Status = "DRAFT" | "IN_PROGRESS" | "COMPLETED";
const STATUS_META: Record<Status, { label: string; tone: string }> = {
  DRAFT: { label: "草稿", tone: "warning" },
  IN_PROGRESS: { label: "进行中", tone: "primary" },
  COMPLETED: { label: "已完成", tone: "success" },
};

const POLL_INTERVAL_MS = 2500;
const POLL_CAP_MS = 6 * 60 * 1000; // §2.2 有界中间态

type StartResponse = { jobId: string; taskId: string; status: string };
type DecomposeResult = {
  projectId?: string;
  sellingPoint?: string;
  scene?: string;
  sceneType?: string;
  styleKeywords?: string[];
  summary?: string;
};
type JobPoll = {
  jobId: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  progress: number;
  result?: DecomposeResult;
  failedReason?: string;
};

export default function HomePage() {
  const { wsId, brandName, user } = useBrand();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () =>
      apiFetch<Project[]>(`/api/workspaces/${wsId}/projects?latestCover=1`),
  });

  // B2 · 首页 AI 拆解 — REAL async decomposition (§2). Submit brief → POST
  // 202 {taskId, jobId} → poll the task for status, then read the decomposed
  // seeds from the job return value → 立项 a draft Campaign + navigate to the
  // workspace prefilled (sellingPoint / scene / sceneType / styleKeywords).
  const [brief, setBrief] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(0);
  const navigatedRef = useRef(false);

  const start = useMutation({
    mutationFn: (text: string) => {
      startedAt.current = Date.now();
      setTimedOut(false);
      navigatedRef.current = false;
      return apiFetch<StartResponse>(
        `/api/workspaces/${wsId}/brief/decompose`,
        { method: "POST", body: JSON.stringify({ text: text.slice(0, 4000) }) },
      );
    },
    onSuccess: (res) => {
      setTaskId(res.taskId);
      setJobId(res.jobId);
    },
  });

  const { data: task } = useQuery<TaskState>({
    queryKey: ["brandai-task", wsId, taskId],
    queryFn: () => apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      if (Date.now() - startedAt.current > POLL_CAP_MS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  const status = task?.status ?? (taskId ? "PENDING" : null);
  const running =
    !!taskId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;

  // §2.4 bounded-state guard — flip to timed-out so the spinner can't run forever.
  useEffect(() => {
    if (!taskId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [taskId]);

  // On success, read the decomposed seeds from the job return value, then
  // navigate to the workspace prefilled. Fire exactly once.
  useEffect(() => {
    if (status !== "SUCCEEDED" || !jobId || navigatedRef.current) return;
    navigatedRef.current = true;
    (async () => {
      let result: DecomposeResult | undefined;
      // The worker marks the AsyncTask SUCCEEDED before BullMQ flushes the job's
      // returnValue, so the first job poll can race and come back with no
      // result. Retry briefly (bounded ~4s) until the seeds land, then fall
      // back to a plain brief prefill below.
      for (let i = 0; i < 8; i++) {
        try {
          const poll = await apiFetch<JobPoll>(
            `/api/workspaces/${wsId}/brief/decompose?jobId=${jobId}`,
          );
          if (poll.result) {
            result = poll.result;
            break;
          }
        } catch {
          /* transient — retry, then fall back below */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      qc.invalidateQueries({ queryKey: ["brandai-projects", wsId] });
      const params = new URLSearchParams();
      if (result?.projectId) params.set("project", result.projectId);
      // The decomposed selling point seeds the workspace 卖点 (brief fallback).
      params.set(
        "brief",
        (result?.sellingPoint || brief).trim().slice(0, 500),
      );
      if (result?.scene) params.set("scene", result.scene.slice(0, 500));
      if (result?.sceneType) params.set("sceneType", result.sceneType);
      if (result?.styleKeywords?.length) {
        params.set("style", result.styleKeywords.slice(0, 20).join(","));
      }
      router.push(`/workspace?${params.toString()}`);
    })();
  }, [status, jobId, wsId, brief, qc, router]);

  function handleStart() {
    if (running || start.isPending) return;
    const text = brief.trim();
    if (!text) {
      router.push("/workspace");
      return;
    }
    start.mutate(text);
  }

  const busy = start.isPending || running;
  const failed = status === "FAILED" || timedOut;

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <section className="pt-4 text-center">
        <h1 className="text-[44px] font-[650] leading-tight tracking-tight">
          你好，{user.name}
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          用一句话描述你的品牌广告需求，BrandAI 帮你 AI 拆解、立项并受控出图。
        </p>
      </section>

      <section className="mx-auto mt-8 max-w-3xl">
        <AIInput
          value={brief}
          onChange={setBrief}
          onSubmit={handleStart}
          disabled={busy}
          placeholder={`例如：为 ${brandName} 做一组小红书种草主视觉，清透水光风格…`}
          primaryAction={
            <button
              type="button"
              onClick={handleStart}
              disabled={busy}
              className="h-11 shrink-0 rounded-[18px] bg-gradient-to-br from-primary to-accent px-6 text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] transition-opacity disabled:opacity-70"
            >
              {busy
                ? status === "RUNNING"
                  ? "AI 拆解中…"
                  : "正在受理…"
                : brief.trim()
                  ? "AI 拆解并开始创作"
                  : "去出图"}
            </button>
          }
        />
        <p className="mt-2 pl-6 text-xs text-muted-foreground">
          提交后 BrandAI 会用 AI 拆解出核心卖点、画面场景与风格关键词，立项为草稿
          项目，并把拆解结果预填进工作台（服务端异步处理，可离开稍后查看）。
        </p>
        {busy ? (
          <p className="mt-2 pl-6 text-xs text-primary">
            {status === "RUNNING"
              ? "AI 正在拆解你的需求，完成后将自动进入工作台…"
              : "已受理，正在排队拆解…"}
          </p>
        ) : null}
        {start.isError ? (
          <p className="mt-2 pl-6 text-xs text-destructive">
            提交失败：
            {start.error instanceof Error ? start.error.message : "请重试"}
          </p>
        ) : null}
        {failed && !start.isError ? (
          <p className="mt-2 pl-6 text-xs text-destructive">
            AI 拆解未完成（可能超时或失败）。
            <button
              type="button"
              onClick={() => {
                setTaskId(null);
                setJobId(null);
                setTimedOut(false);
              }}
              className="ml-1 underline hover:text-destructive/80"
            >
              重试
            </button>
          </p>
        ) : null}
      </section>

      <section className="mt-10 grid grid-cols-2 gap-[18px] lg:grid-cols-4">
        {quickActions.map((a) => (
          <Link
            key={a.title}
            href={a.href}
            className="group flex flex-col gap-3 rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)] transition-all hover:-translate-y-0.5 hover:border-primary/30"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-lg text-primary">
              {a.icon}
            </span>
            <span className="text-[15px] font-semibold">{a.title}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {a.desc}
            </span>
          </Link>
        ))}
      </section>

      <section className="mt-12">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">近期项目</h2>
          <Link href="/campaigns" className="text-sm text-primary hover:underline">
            查看全部
          </Link>
        </div>
        {projects.length === 0 ? (
          <Link
            href="/campaigns"
            className="flex flex-col items-center rounded-3xl border border-dashed border-border bg-card p-12 text-center transition-colors hover:border-primary/30"
          >
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-xl text-primary">
              ＋
            </span>
            <span className="text-sm font-medium">创建第一个项目</span>
            <span className="mt-1 text-xs text-muted-foreground">
              围绕营销项目管理需求、出图与交付
            </span>
          </Link>
        ) : (
          <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-[18px] overflow-x-auto pb-2">
            {projects.map((c) => {
              const s = STATUS_META[(c.status ?? "DRAFT") as Status];
              return (
                <Link
                  key={c.id}
                  href="/campaigns"
                  className="flex flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)] transition-all hover:-translate-y-0.5"
                >
                  <CampaignCover
                    campaignId={c.id}
                    imageUrl={c.coverImage}
                    name={c.name}
                  />
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="flex items-center gap-2">
                      <span className={badgeCls(s.tone)}>{s.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {brandName}
                      </span>
                    </div>
                    <div className="text-sm font-semibold">{c.name}</div>
                    <ProgressBar value={c.progress ?? 0} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* L2 / B5 / H14 · 推荐品牌瀑布流 — REAL BrandWorkspace rows the user can
          see (owned / member-of). Honest empty state when none. */}
      <RecommendedBrands />
    </div>
  );
}

function CampaignCover({
  campaignId,
  imageUrl,
  name,
}: {
  campaignId: string;
  imageUrl?: string;
  name: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!imageUrl || failed) {
    return <div className="h-32" style={{ background: gradientFor(campaignId) }} />;
  }

  return (
    <div className="h-32 overflow-hidden">
      {/* Dynamic storage and provider URLs cannot be safely enumerated for next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt={`${name} 最新生成图`}
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function badgeCls(tone: string) {
  const map: Record<string, string> = {
    primary: "bg-accent-soft text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
  };
  return `rounded-full px-2.5 py-0.5 text-[11px] font-medium ${map[tone] ?? map.primary}`;
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-[11px] text-muted-foreground">{value}%</span>
    </div>
  );
}
