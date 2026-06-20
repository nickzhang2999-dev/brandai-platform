"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Generation, Project } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import {
  getReferences,
  removeReference,
  subscribeReferences,
  type RefAsset,
} from "@/lib/reference-tray";
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

const EDIT_OPS: { value: string; label: string }[] = [
  { value: "REPLACE_BACKGROUND", label: "换背景" },
  { value: "RECOLOR", label: "改色" },
  { value: "EDIT_TEXT", label: "改文字" },
  { value: "ADD_ELEMENT", label: "加元素" },
  { value: "REMOVE_ELEMENT", label: "去元素" },
];

const POLL_CAP_MS = 6 * 60 * 1000; // §2.2 有界中间态

type JobState = {
  generation: Generation;
  job: { jobId: string; status: string; progress: number; failedReason?: string };
};

// F11 — read-only quota status (GET /api/workspaces/[wsId]/quota). -1 = 不限.
type QuotaStatus = {
  dailyUsed: number;
  dailyLimit: number;
  periodUsed: number;
  monthlyQuota: number;
  plan: string;
};

// F7 — UI suggestion chips (text content only; not colors).
const SUGGESTED_KEYWORDS = ["简约", "高级感", "科技感", "暖色调", "自然光"];
const MAX_KEYWORDS = 20;

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

  // F7 · 风格关键词 (max 20) — threaded into POST /generations as styleKeywords.
  const [styleKeywords, setStyleKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");

  function addKeyword(raw: string) {
    const kw = raw.trim();
    if (!kw) return;
    setStyleKeywords((prev) =>
      prev.includes(kw) || prev.length >= MAX_KEYWORDS ? prev : [...prev, kw],
    );
  }
  function removeKeyword(kw: string) {
    setStyleKeywords((prev) => prev.filter((k) => k !== kw));
  }
  function onKeywordKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(keywordDraft);
      setKeywordDraft("");
    } else if (e.key === "Backspace" && !keywordDraft && styleKeywords.length) {
      removeKeyword(styleKeywords[styleKeywords.length - 1]!);
    }
  }

  // F9 · 参考素材区 — localStorage-backed, scoped to (wsId, projectId), shared
  // with the assets page via reference-tray. Subscribe for cross-page updates.
  const [references, setReferences] = useState<RefAsset[]>([]);
  useEffect(() => {
    if (!projectId) {
      setReferences([]);
      return;
    }
    const refresh = () => setReferences(getReferences(wsId, projectId));
    refresh();
    return subscribeReferences(refresh);
  }, [wsId, projectId]);
  function dropReference(assetId: string) {
    if (!projectId) return;
    removeReference(wsId, projectId, assetId);
    setReferences(getReferences(wsId, projectId));
  }

  // F11 · 生成额度展示 — read-only quota status.
  const { data: quota } = useQuery<QuotaStatus>({
    queryKey: ["brandai-quota", wsId],
    queryFn: () => apiFetch<QuotaStatus>(`/api/workspaces/${wsId}/quota`),
    enabled: !!wsId,
  });

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

  // —— 修改优化(改图)/ 终选 / 交付归档 ——
  const qc = useQueryClient();
  const [editOp, setEditOp] = useState("REPLACE_BACKGROUND");
  const [editInstr, setEditInstr] = useState("");
  const [editVid, setEditVid] = useState<string | null>(null);
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "edit" | "final" | "export">(null);

  // 改图 server-authoritative:POST→202→轮询 edit job→成功后刷新主 generation,
  // 新的子版本(parentVersionId)就会出现在变体条里。
  const { data: editPoll } = useQuery<{ job?: { status: string } }>({
    queryKey: ["brandai-edit", wsId, genId, editVid, editJobId],
    queryFn: () =>
      apiFetch(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${editVid}/edit?jobId=${editJobId}`,
      ),
    enabled: !!editJobId && !!editVid && !!genId,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status;
      return s === "SUCCEEDED" || s === "FAILED" ? false : 2500;
    },
  });
  useEffect(() => {
    const s = editPoll?.job?.status;
    if (s === "SUCCEEDED") {
      setEditJobId(null);
      setEditVid(null);
      setEditInstr("");
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } else if (s === "FAILED") {
      setEditJobId(null);
      setActionErr("改图失败,请重试");
    }
  }, [editPoll, qc, wsId, genId]);
  const editing = !!editJobId;

  async function submitEdit() {
    if (!current || !genId || !editInstr.trim()) return;
    setActionErr(null);
    setBusy("edit");
    try {
      const r = await apiFetch<{ jobId: string }>(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${current.id}/edit`,
        {
          method: "POST",
          body: JSON.stringify({
            op: editOp,
            payload: { prompt: editInstr.trim() },
          }),
        },
      );
      setEditVid(current.id);
      setEditJobId(r.jobId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "改图提交失败");
    } finally {
      setBusy(null);
    }
  }

  async function markFinal() {
    if (!current || !genId) return;
    setActionErr(null);
    setBusy("final");
    try {
      await apiFetch(`/api/workspaces/${wsId}/generations/${genId}`, {
        method: "PATCH",
        body: JSON.stringify({ versionId: current.id }),
      });
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "设为终稿失败");
    } finally {
      setBusy(null);
    }
  }

  async function exportKit() {
    if (!projectId) return;
    const finals = versions.filter((v) => v.isFinal).map((v) => v.id);
    const ids = finals.length > 0 ? finals : current ? [current.id] : [];
    if (ids.length === 0) return;
    setActionErr(null);
    setBusy("export");
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/projects/${projectId}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ versionIds: ids }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "导出失败");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "brandai-delivery.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }

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
            // F7 — only send when non-empty (frozen-additive optional field).
            ...(styleKeywords.length ? { styleKeywords } : {}),
            // F9 — current project's staged reference asset ids.
            ...(references.length
              ? { referenceAssetIds: references.map((r) => r.id) }
              : {}),
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
            <div className="mt-4 flex flex-wrap gap-3">
              {versions.map((v, i) => (
                <button
                  key={v.id}
                  onClick={() => setActiveVariant(i)}
                  className={[
                    "relative h-[82px] w-[118px] overflow-hidden rounded-[18px] border-2 transition-colors",
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
                  {v.isFinal ? (
                    <span className="absolute left-1 top-1 rounded-full bg-success px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                      终稿
                    </span>
                  ) : null}
                  {v.parentVersionId ? (
                    <span className="absolute right-1 top-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      改
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {/* 修改优化 / 终选 / 交付归档 —— 仅在已出图后对选中变体可用 */}
          {status === "SUCCEEDED" && current ? (
            <div className="mt-4 rounded-2xl border border-border bg-card p-4">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">
                对选中图片
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {EDIT_OPS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => setEditOp(o.value)}
                    className={[
                      "rounded-full px-2.5 py-1 text-xs transition-colors",
                      editOp === o.value
                        ? "bg-accent-soft font-medium text-primary"
                        : "border border-border text-muted-foreground hover:bg-muted",
                    ].join(" ")}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={editInstr}
                  onChange={(e) => setEditInstr(e.target.value)}
                  placeholder="改图指令,如:把背景换成纯色米白、瓶身更通透…"
                  className="h-10 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40"
                />
                <button
                  onClick={submitEdit}
                  disabled={!editInstr.trim() || busy === "edit" || editing}
                  className="h-10 shrink-0 rounded-xl bg-gradient-to-br from-primary to-accent px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {editing ? "改图中…" : "改图"}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={markFinal}
                  disabled={busy === "final" || current.isFinal}
                  className="rounded-full border border-success/40 px-3 py-1.5 text-xs text-success transition-colors hover:bg-success/10 disabled:opacity-60"
                >
                  {current.isFinal ? "✓ 已是终稿" : "设为终稿"}
                </button>
                <button
                  onClick={exportKit}
                  disabled={busy === "export"}
                  className="rounded-full border border-primary/40 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-accent-soft disabled:opacity-60"
                >
                  {busy === "export"
                    ? "打包中…"
                    : versions.some((v) => v.isFinal)
                      ? "导出交付包(终稿)"
                      : "导出交付包(当前图)"}
                </button>
              </div>
              {actionErr ? (
                <p className="mt-2 text-xs text-destructive">{actionErr}</p>
              ) : null}
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

          {/* F7 · 风格关键词 */}
          <div>
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              <span>风格关键词</span>
              <span className="text-xs font-normal text-muted-foreground">
                {styleKeywords.length}/{MAX_KEYWORDS}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-background p-2 focus-within:border-primary/40 focus-within:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]">
              {styleKeywords.map((kw) => (
                <span
                  key={kw}
                  className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-primary"
                >
                  {kw}
                  <button
                    type="button"
                    onClick={() => removeKeyword(kw)}
                    aria-label={`移除 ${kw}`}
                    className="text-primary/60 transition-colors hover:text-primary"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
                onKeyDown={onKeywordKeyDown}
                onBlur={() => {
                  addKeyword(keywordDraft);
                  setKeywordDraft("");
                }}
                disabled={styleKeywords.length >= MAX_KEYWORDS}
                placeholder={
                  styleKeywords.length >= MAX_KEYWORDS
                    ? "已达上限"
                    : "输入后回车添加…"
                }
                className="min-w-[7rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SUGGESTED_KEYWORDS.filter((k) => !styleKeywords.includes(k)).map(
                (k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => addKeyword(k)}
                    disabled={styleKeywords.length >= MAX_KEYWORDS}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    + {k}
                  </button>
                ),
              )}
            </div>
          </div>

          {/* F9 · 参考素材区 */}
          {projectId ? (
            <div>
              <div className="mb-2 flex items-center justify-between text-sm font-semibold">
                <span>参考素材</span>
                {references.length ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {references.length}/8
                  </span>
                ) : null}
              </div>
              {references.length ? (
                <div className="flex flex-wrap gap-2">
                  {references.map((r) => (
                    <div
                      key={r.id}
                      className="group relative h-16 w-16 overflow-hidden rounded-xl border border-border bg-background"
                    >
                      {r.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.thumbUrl}
                          alt={r.fileName ?? "参考素材"}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          ◇
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => dropReference(r.id)}
                        aria-label="移除参考素材"
                        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-card/90 text-xs text-muted-foreground shadow-sm transition-colors hover:text-destructive"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-2xl border border-dashed border-border bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                  从素材库『设为参考』添加
                </p>
              )}
            </div>
          ) : null}

          {/* F11 · 生成额度展示 */}
          {quota ? <QuotaBar quota={quota} /> : null}

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

// F11 — compact period/day usage with a violet bar. -1 = 不限.
function QuotaBar({
  quota,
}: {
  quota: {
    dailyUsed: number;
    dailyLimit: number;
    periodUsed: number;
    monthlyQuota: number;
    plan: string;
  };
}) {
  const { periodUsed, monthlyQuota, dailyUsed, dailyLimit, plan } = quota;
  const monthlyText = monthlyQuota === -1 ? "不限" : monthlyQuota;
  const dailyText = dailyLimit === -1 ? "不限" : dailyLimit;
  const pct =
    monthlyQuota > 0
      ? Math.min(100, Math.round((periodUsed / monthlyQuota) * 100))
      : monthlyQuota === -1
        ? 0
        : 100;
  return (
    <div className="rounded-2xl border border-border bg-background p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">生成额度</span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
          {plan}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        本周期{" "}
        <span className="font-medium text-foreground">
          {periodUsed}/{monthlyText}
        </span>{" "}
        · 今日{" "}
        <span className="font-medium text-foreground">
          {dailyUsed}/{dailyText}
        </span>
      </p>
      {monthlyQuota !== -1 ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-accent-soft">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
