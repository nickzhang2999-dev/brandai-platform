"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { Generation, Project } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import { useBrand } from "../brand-context";

/**
 * P05 · AI 工作台 — 左画布 + 变体条，右 prompt 面板。真实出图（CLAUDE.md §2，
 * server-authoritative）：提交 → POST /generations(202, 落 PENDING + 入队) →
 * 客户端轮询 GET /generations/[id]?jobId= → worker→apps/ai→真 provider 出图 →
 * GenerationVersion.imageUrl 浮现。客户端中间态有界，超时给出口。
 */
const SCENE_TYPES: { value: string; label: string }[] = [
  { value: "SOCIAL_POSTER", label: "社交海报" },
  { value: "ECOM_MAIN", label: "电商主图" },
  { value: "SCENE", label: "场景图" },
  { value: "CAMPAIGN_KV", label: "Campaign KV" },
  { value: "SELLING_POINT", label: "卖点图" },
];

const POLL_CAP_MS = 6 * 60 * 1000; // §2.2 有界中间态

type JobState = {
  generation: Generation;
  job: { jobId: string; status: string; progress: number; failedReason?: string };
};

export default function WorkspacePage() {
  return (
    <Suspense fallback={<div className="p-10 text-sm text-muted-foreground">加载中…</div>}>
      <Workspace />
    </Suspense>
  );
}

function Workspace() {
  const { wsId } = useBrand();
  const search = useSearchParams();
  const presetProject = search.get("project");

  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  const [projectId, setProjectId] = useState<string | null>(presetProject);
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const [sellingPoint, setSellingPoint] = useState(
    "高端、清透、具有自然光感的护肤新品社交广告主视觉，紫色瓶身为主体，搭配花卉与水光质感。",
  );
  const [scene, setScene] = useState("夏日自然光场景");
  const [sceneType, setSceneType] = useState("SOCIAL_POSTER");
  const [versionCount, setVersionCount] = useState(4);

  const [genId, setGenId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [activeVariant, setActiveVariant] = useState(0);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const startedAt = useRef<number>(0);
  const [timedOut, setTimedOut] = useState(false);

  const { data: poll } = useQuery<JobState>({
    queryKey: ["brandai-gen", wsId, genId, jobId],
    queryFn: () =>
      apiFetch<JobState>(
        `/api/workspaces/${wsId}/generations/${genId}?jobId=${jobId}`,
      ),
    enabled: !!genId,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status ?? q.state.data?.generation.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      if (Date.now() - startedAt.current > POLL_CAP_MS) return false;
      return 2500;
    },
  });

  useEffect(() => {
    if (!genId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [genId]);

  const status = poll?.job?.status ?? poll?.generation.status ?? null;
  const versions = useMemo(
    () => poll?.generation.versions ?? [],
    [poll],
  );
  const running = !!genId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;
  const current = versions[activeVariant] ?? versions[0];

  async function submit() {
    if (!projectId) {
      setSubmitErr("请先选择一个 Campaign 项目（没有就去 Campaign 页创建）");
      return;
    }
    setSubmitErr(null);
    setSubmitting(true);
    setTimedOut(false);
    setActiveVariant(0);
    try {
      const res = await apiFetch<{ generation: Generation; jobId: string }>(
        `/api/workspaces/${wsId}/generations`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            sceneType,
            sellingPoint: sellingPoint.trim(),
            scene: scene.trim(),
            versionCount,
          }),
        },
      );
      startedAt.current = Date.now();
      setGenId(res.generation.id);
      setJobId(res.jobId);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>AI 工作台</span>
          <span>/</span>
          <select
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value || null)}
            className="rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground outline-none"
          >
            {projects.length === 0 ? (
              <option value="">无项目，请先去 Campaign 创建</option>
            ) : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <StatusPill status={status} timedOut={timedOut} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_400px]">
        {/* Canvas */}
        <div className="flex min-h-0 flex-col bg-background p-6">
          <div className="flex flex-1 items-center justify-center overflow-hidden rounded-3xl border border-border bg-card p-6">
            {current?.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={current.imageUrl}
                alt="生成结果"
                className="max-h-[560px] max-w-full rounded-2xl object-contain shadow-[0_26px_80px_rgba(124,92,255,0.24)]"
              />
            ) : (
              <CanvasPlaceholder
                running={running}
                status={status}
                timedOut={timedOut}
                error={poll?.job?.failedReason ?? poll?.generation.error ?? undefined}
              />
            )}
          </div>
          {versions.length > 0 ? (
            <div className="mt-4 flex gap-3">
              {versions.map((v, i) => (
                <button
                  key={v.id}
                  onClick={() => setActiveVariant(i)}
                  className={[
                    "h-[82px] w-[118px] overflow-hidden rounded-[18px] border-2 transition-colors",
                    i === activeVariant
                      ? "border-primary"
                      : "border-transparent hover:border-border",
                  ].join(" ")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={v.imageUrl}
                    alt={`变体 ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Prompt panel */}
        <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l border-border bg-card p-6">
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              <span>需求描述 / 卖点</span>
              <span className="text-xs font-normal text-muted-foreground">
                {sellingPoint.length}/500
              </span>
            </div>
            <textarea
              value={sellingPoint}
              maxLength={500}
              onChange={(e) => setSellingPoint(e.target.value)}
              rows={5}
              className="w-full resize-none rounded-2xl border border-border bg-background p-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">场景</div>
            <input
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">画面类型</div>
            <div className="flex flex-wrap gap-1.5">
              {SCENE_TYPES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSceneType(s.value)}
                  className={[
                    "rounded-full px-3 py-1 text-xs transition-colors",
                    sceneType === s.value
                      ? "bg-accent-soft font-medium text-primary"
                      : "border border-border text-muted-foreground hover:bg-muted",
                  ].join(" ")}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold">生成数量</div>
            <div className="flex gap-1.5">
              {[1, 2, 4, 6].map((n) => (
                <button
                  key={n}
                  onClick={() => setVersionCount(n)}
                  className={[
                    "h-9 w-12 rounded-xl text-sm transition-colors",
                    versionCount === n
                      ? "bg-accent-soft font-medium text-primary"
                      : "border border-border text-muted-foreground hover:bg-muted",
                  ].join(" ")}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-primary/15 bg-accent-soft/50 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <span>◎</span> 品牌约束已生效
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              出图在 worker 中加载本品牌已确认的知识库规则（色彩/字体/Logo/调性）
              进行受控生成。
            </p>
          </div>

          {submitErr ? (
            <p className="text-sm text-destructive">{submitErr}</p>
          ) : null}

          <div className="mt-auto">
            <button
              onClick={submit}
              disabled={submitting || running}
              className="h-12 w-full rounded-[18px] bg-gradient-to-br from-primary to-accent text-sm font-medium text-primary-foreground shadow-[0_12px_28px_rgba(124,92,255,0.26)] disabled:opacity-70"
            >
              {running
                ? "AI 正在生成…"
                : submitting
                  ? "提交中…"
                  : "提交制作"}
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              内容由 AI 生成，请注意核对准确性。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function StatusPill({
  status,
  timedOut,
}: {
  status: string | null;
  timedOut: boolean;
}) {
  if (timedOut)
    return <Pill tone="warning">超时，请重试</Pill>;
  if (!status) return null;
  const map: Record<string, { tone: Tone; label: string }> = {
    PENDING: { tone: "muted", label: "已受理 · 排队中" },
    RUNNING: { tone: "primary", label: "生成中…" },
    SUCCEEDED: { tone: "success", label: "已完成" },
    FAILED: { tone: "danger", label: "失败" },
  };
  const m = map[status] ?? { tone: "muted" as Tone, label: status };
  return <Pill tone={m.tone}>{m.label}</Pill>;
}

type Tone = "muted" | "primary" | "success" | "danger" | "warning";
function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const map: Record<Tone, string> = {
    muted: "bg-muted text-muted-foreground",
    primary: "bg-accent-soft text-primary",
    success: "bg-success/10 text-success",
    danger: "bg-destructive/10 text-destructive",
    warning: "bg-warning/10 text-warning",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

function CanvasPlaceholder({
  running,
  status,
  timedOut,
  error,
}: {
  running: boolean;
  status: string | null;
  timedOut: boolean;
  error?: string;
}) {
  if (timedOut)
    return (
      <Center>
        <div className="text-sm text-warning">生成超时</div>
        <p className="mt-1 text-xs text-muted-foreground">
          可能仍在后台处理或已失败，请点「提交制作」重试。
        </p>
      </Center>
    );
  if (status === "FAILED")
    return (
      <Center>
        <div className="text-sm text-destructive">生成失败</div>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {error || "请检查 AI provider 配置或稍后重试。"}
        </p>
      </Center>
    );
  if (running)
    return (
      <Center>
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-accent-soft border-t-primary" />
        <div className="mt-3 text-sm text-muted-foreground">
          {status === "PENDING" ? "已受理，排队中…" : "AI 正在生成…"}
        </div>
      </Center>
    );
  return (
    <Center>
      <div className="text-5xl text-accent-soft">✸</div>
      <div className="mt-3 text-sm font-medium">填写需求并提交制作</div>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        提交后由 worker 调用真实 AI provider 受控出图，结果会浮现在这里。
      </p>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center">
      {children}
    </div>
  );
}
