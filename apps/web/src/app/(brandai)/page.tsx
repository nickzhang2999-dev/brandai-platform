"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskState } from "@brandai/contracts";
import { ArrowRight, LoaderCircle, SendHorizontal } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { useBrand } from "./brand-context";
import { AIInput } from "./ai-input";

/**
 * P01 · 首页 — 新版沉浸式 AI 入口。左侧品牌视觉，右侧直接发起真实 AI 拆解。
 */
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
    queryFn: () =>
      apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${taskId}`),
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
      params.set("brief", (result?.sellingPoint || brief).trim().slice(0, 500));
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
    <div className="min-h-screen bg-card lg:grid lg:grid-cols-[minmax(420px,42%)_1fr]">
      <section className="relative h-[34vh] min-h-[250px] overflow-hidden lg:h-screen lg:min-h-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/brandai-hero-orb.jpg"
          alt="紫色粒子构成的 BrandAI 抽象球体"
          className="h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-card/5 via-transparent to-primary/10" />
      </section>

      <section className="relative flex min-h-[66vh] flex-col overflow-hidden bg-gradient-to-br from-card via-card to-accent-soft/70 lg:min-h-screen">
        <nav
          aria-label="首页导航"
          className="flex h-20 shrink-0 items-center justify-center gap-7 px-6 text-xs text-muted-foreground sm:justify-end sm:gap-10 sm:px-12 lg:px-16"
        >
          <Link
            className="transition-colors hover:text-foreground"
            href="/brand-knowledge"
          >
            品牌套件
          </Link>
          <Link
            className="transition-colors hover:text-foreground"
            href="/campaigns"
          >
            项目库
          </Link>
          <Link
            className="transition-colors hover:text-foreground"
            href="/assets"
          >
            素材库
          </Link>
          <Link
            className="ml-auto transition-colors hover:text-foreground sm:ml-8"
            href="/account"
          >
            账号设置
          </Link>
        </nav>

        <div className="mx-auto grid w-full max-w-[780px] flex-1 grid-rows-[1fr_auto] px-6 pb-8 sm:px-12 lg:px-16 lg:pb-[8vh]">
          <div className="flex flex-col items-center justify-center pb-10 text-center lg:pb-2">
            <h1 className="text-[34px] font-bold tracking-[0.02em] sm:text-[42px]">
              您好，{user.name}
            </h1>
            <p className="mt-4 text-sm text-muted-foreground sm:text-base">
              用一句话总结您的品牌，让 BrandAI 帮您拆解
            </p>
          </div>

          <div className="w-full">
            <Link
              href="/brand-knowledge"
              className="mb-2 inline-flex h-10 items-center gap-4 rounded-xl bg-foreground px-4 text-sm font-medium text-background transition-transform hover:-translate-y-0.5"
            >
              创建品牌套件
              <ArrowRight className="h-4 w-4" />
            </Link>
            <AIInput
              variant="hero"
              value={brief}
              onChange={setBrief}
              onSubmit={handleStart}
              disabled={busy}
              rows={5}
              placeholder={`简单描述您的需求，BrandAI 将自动拆解「${brandName}」的品牌调性`}
              primaryAction={
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={busy}
                  aria-label={busy ? "正在拆解需求" : "发送需求"}
                  title={busy ? "正在拆解需求" : "发送需求"}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-[0_10px_24px_rgba(31,31,42,0.18)] transition-transform hover:scale-105 disabled:opacity-60"
                >
                  {busy ? (
                    <LoaderCircle className="h-5 w-5 animate-spin" />
                  ) : (
                    <SendHorizontal className="h-5 w-5" />
                  )}
                </button>
              }
            />
            <div className="mt-2 min-h-5 px-2 text-xs">
              {busy ? (
                <p className="text-primary">
                  {status === "RUNNING"
                    ? "AI 正在拆解需求，完成后将自动进入工作台…"
                    : "已受理，正在排队拆解…"}
                </p>
              ) : null}
              {start.isError ? (
                <p className="text-destructive">
                  提交失败：
                  {start.error instanceof Error
                    ? start.error.message
                    : "请重试"}
                </p>
              ) : null}
              {failed && !start.isError ? (
                <p className="text-destructive">
                  AI 拆解未完成。
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
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
