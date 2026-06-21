"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Asset, AssetFolder, Project, TaskState } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import {
  addReference,
  REFERENCE_CAP,
  type AddReferenceResult,
} from "@/lib/reference-tray";
import { useBrand } from "../brand-context";
import { Chip, gradientFor, PageHeader } from "../_ui";

/**
 * P04 · 素材库 — 统计卡 + 类型筛选 + 素材网格 + 右侧详情面板。真实数据：
 * GET /api/workspaces/[wsId]/assets，上传走 POST /assets/upload（multipart）。
 */
const CATEGORIES: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "LOGO", label: "Logo" },
  { value: "PRODUCT", label: "产品图" },
  { value: "PACKAGING", label: "包装" },
  { value: "KV", label: "主视觉" },
  { value: "SOCIAL", label: "社媒" },
  { value: "VI_DOC", label: "VI 文档" },
  { value: "OTHER", label: "其他" },
];
const CAT_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
);

/** E13 · 使用记录 wire shape (assets/[assetId]/usage route). */
type UsageRecord = {
  generationId: string;
  projectId: string;
  projectName: string;
  scene: string;
  sceneType: string;
  usedAt: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function fmtSize(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function isImage(a: Asset): boolean {
  return (a.mimeType ?? "").startsWith("image/");
}
/**
 * P1.3 — whether the asset may feed generation/references. `availableForGeneration`
 * defaults to true on the wire when omitted (legacy rows); a set `deprecatedAt`
 * also marks it unusable.
 */
function isAvailable(a: Asset): boolean {
  return a.availableForGeneration !== false && !a.deprecatedAt;
}

export default function AssetsPage() {
  const { wsId } = useBrand();
  const qc = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  // E13 — show only favorited assets when on.
  const [favOnly, setFavOnly] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // H6 · 上传弹窗 — open state. The hidden <input> is driven from inside the
  // dialog so category/folder are chosen first, then the file picker fires.
  const [uploadDialog, setUploadDialog] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  // H8 · 查看来源弹窗 — the asset whose source/metadata is being inspected.
  const [sourceAsset, setSourceAsset] = useState<Asset | null>(null);
  // E11/E12 · 参考素材联动：选中的目标 Campaign + 暂存确认提示。
  const [pickProject, setPickProject] = useState("");
  const [stagedNote, setStagedNote] = useState<{
    projectId: string;
    projectName: string;
    result: AddReferenceResult;
  } | null>(null);
  // H7 · 加入项目弹窗 — 打开后选择 Campaign 并确认（诚实：暂存为该 Campaign 的参考
  // 素材，出图时带入；一期无 Project↔Asset DB 关系）。
  const [joinDialog, setJoinDialog] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // E3 · 文件夹组织 — 当前选中的文件夹筛选 + 新建文件夹弹窗。
  // folderFilter: "all" = 全部, "none" = 未归档, 否则为文件夹 id。
  const [folderFilter, setFolderFilter] = useState("all");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Deep-link: /assets?category=LOGO preselects the type filter — e.g. the
  // brand-knowledge upload dialog's "在素材库查看该分类" link. Read once on
  // mount; ignore unknown values so a stale/garbage param can't blank the grid.
  useEffect(() => {
    const cat = new URLSearchParams(window.location.search).get("category");
    if (cat && CATEGORIES.some((c) => c.value === cat)) setFilter(cat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: assets = [], isLoading } = useQuery({
    queryKey: ["brandai-assets", wsId],
    queryFn: () => apiFetch<Asset[]>(`/api/workspaces/${wsId}/assets`),
  });

  // 共享 ["brandai-projects", wsId] 缓存（与首页/工作台/项目页同 key）。
  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  // E3 · 素材文件夹 — workspace 作用域，含 assetCount。
  const { data: folders = [] } = useQuery({
    queryKey: ["brandai-folders", wsId],
    queryFn: () => apiFetch<AssetFolder[]>(`/api/workspaces/${wsId}/folders`),
  });
  const invalidateFolders = () => {
    qc.invalidateQueries({ queryKey: ["brandai-folders", wsId] });
    qc.invalidateQueries({ queryKey: ["brandai-assets", wsId] });
  };
  const createFolder = useMutation({
    mutationFn: (name: string) =>
      apiFetch<AssetFolder>(`/api/workspaces/${wsId}/folders`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      invalidateFolders();
      setCreatingFolder(false);
    },
  });
  const moveAsset = useMutation({
    mutationFn: ({
      assetId,
      folderId,
    }: {
      assetId: string;
      folderId: string | null;
    }) =>
      apiFetch<Asset>(`/api/workspaces/${wsId}/assets/${assetId}`, {
        method: "PATCH",
        body: JSON.stringify({ folderId }),
      }),
    onSuccess: invalidateFolders,
  });

  const upload = useMutation({
    mutationFn: async (args: {
      file: File;
      category: string;
      folderId: string | null;
    }) => {
      const fd = new FormData();
      fd.append("file", args.file);
      fd.append("category", args.category);
      if (args.folderId) fd.append("folderId", args.folderId);
      const res = await fetch(`/api/workspaces/${wsId}/assets/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "上传失败");
      }
      return (await res.json()) as Asset;
    },
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["brandai-assets", wsId] });
      qc.invalidateQueries({ queryKey: ["brandai-folders", wsId] });
      setActiveId(a.id);
      setUploadErr(null);
      setUploadDialog(false);
    },
    onError: (e) => setUploadErr((e as Error).message),
  });

  // E13 · 收藏 toggle — PATCH Asset.isFavorite (field exists in schema). Optimism
  // isn't needed; React Query refetch surfaces the new star state quickly.
  const toggleFavorite = useMutation({
    mutationFn: (a: Asset) =>
      apiFetch<Asset>(`/api/workspaces/${wsId}/assets/${a.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isFavorite: !a.isFavorite }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["brandai-assets", wsId] }),
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return assets.filter((a) => {
      if (filter !== "all" && a.category !== filter) return false;
      // E13 — favorites-only filter.
      if (favOnly && !a.isFavorite) return false;
      // E4 — real search across fileName + AI tags + AI description (the
      // searchable text the asset actually carries).
      if (needle) {
        const haystack = [
          a.fileName,
          a.aiDescription ?? "",
          ...(a.aiTags ?? []),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      // E3 — folder filter: all / none (un-filed) / a specific folder id.
      if (folderFilter === "none" && a.folderId) return false;
      if (
        folderFilter !== "all" &&
        folderFilter !== "none" &&
        a.folderId !== folderFilter
      )
        return false;
      return true;
    });
  }, [assets, filter, q, favOnly, folderFilter]);
  // Detail pane must track the FILTERED grid — falling back to assets[0] would
  // show a sidebar asset that isn't visible under the active filter/search.
  const active = filtered.find((a) => a.id === activeId) ?? filtered[0];

  // E13 · 使用记录 — real linkage derived from generation versions referencing
  // this asset (see assets/[assetId]/usage route). Empty list → honest
  // "暂无使用记录" empty state (no fabrication).
  const { data: usage = [], isLoading: usageLoading } = useQuery<UsageRecord[]>({
    queryKey: ["brandai-asset-usage", wsId, active?.id],
    queryFn: () =>
      apiFetch<UsageRecord[]>(
        `/api/workspaces/${wsId}/assets/${active!.id}/usage`,
      ),
    enabled: !!active?.id,
  });

  // E9/E10 · AI 智能标注/生成描述 — POST 起异步任务（worker 调 /v1/describe →
  // 真 VLM → 回写 Asset.aiTags/aiDescription），客户端轮询任务，成功后刷新素材。
  const [describeTaskId, setDescribeTaskId] = useState<string | null>(null);
  const [describeTimedOut, setDescribeTimedOut] = useState(false);
  // Which asset the in-flight describe belongs to — so the progress/disabled UI
  // only shows on that asset's detail pane, not whichever asset is selected.
  const [describeAssetId, setDescribeAssetId] = useState<string | null>(null);
  const describeStartedAt = useRef(0);
  const describe = useMutation({
    mutationFn: (assetId: string) => {
      describeStartedAt.current = Date.now();
      return apiFetch<{ taskId: string }>(
        `/api/workspaces/${wsId}/assets/${assetId}/describe`,
        { method: "POST" },
      );
    },
    onSuccess: (res) => setDescribeTaskId(res.taskId),
  });
  const { data: describeTask } = useQuery<TaskState>({
    queryKey: ["brandai-describe-task", wsId, describeTaskId],
    queryFn: () =>
      apiFetch<TaskState>(`/api/workspaces/${wsId}/tasks/${describeTaskId}`),
    enabled: !!describeTaskId,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      // bounded intermediate (§2.2) — stop polling after 6 min.
      if (Date.now() - describeStartedAt.current > 6 * 60_000) return false;
      return 2000;
    },
  });
  const describeStatus =
    describeTask?.status ?? (describeTaskId ? "PENDING" : null);
  const describeRunning =
    !!describeTaskId &&
    describeStatus !== "SUCCEEDED" &&
    describeStatus !== "FAILED" &&
    !describeTimedOut;
  // §2.4 bounded-state guard — after the 6-min poll cap the query stops
  // refetching; flip a timed-out flag so the button re-enables (retry) instead
  // of being stuck on "AI 标注中…" forever (mirrors home/campaigns timedOut).
  useEffect(() => {
    if (!describeTaskId) return;
    if (describeStatus === "SUCCEEDED" || describeStatus === "FAILED") return;
    const t = setInterval(() => {
      if (Date.now() - describeStartedAt.current > 6 * 60_000) {
        setDescribeTimedOut(true);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [describeTaskId, describeStatus]);
  // Busy state scoped to the asset that started the describe — switching to
  // another asset must not show "AI 标注中…"/disable its button.
  const describeBusyHere =
    (describe.isPending || describeRunning) && describeAssetId === active?.id;
  // On success, refresh assets (so the new tags/description surface) once.
  const describeFiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      describeStatus === "SUCCEEDED" &&
      describeTaskId &&
      describeFiredFor.current !== describeTaskId
    ) {
      describeFiredFor.current = describeTaskId;
      qc.invalidateQueries({ queryKey: ["brandai-assets", wsId] });
    }
  }, [describeStatus, describeTaskId, qc, wsId]);

  // E11/E12 · 把当前选中素材暂存为目标 Campaign 的参考素材（client-side staging，
  // 一期无 Project↔Asset DB 关系，暂存于 reference-tray，工作台出图时读取）。
  function stageActiveAsReference(
    projectId: string,
  ): { project: Project; result: AddReferenceResult } | null {
    // Only generatable IMAGE assets can be references (POST /generations rejects
    // non-images), so don't stage PDFs/VI_DOC and create a client-allowed /
    // server-rejected mismatch. P1.3 — also skip assets the workspace marked
    // unavailable / deprecated for generation (now exposed on the wire type) so
    // the user can't stage a reference the generate worker will silently drop.
    if (!active || !isImage(active) || !isAvailable(active) || !projectId)
      return null;
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;
    const result = addReference(wsId, projectId, {
      id: active.id,
      fileName: active.fileName,
      thumbUrl: assetThumbUrl(wsId, active.id, active.url),
    });
    return { project, result };
  }

  // E12 「设为参考」：暂存后留在本页 + 给出"去工作台查看"链接（满额/重复也如实反馈）。
  function handleSetReference() {
    const r = stageActiveAsReference(pickProject);
    if (!r) return;
    setStagedNote({
      projectId: r.project.id,
      projectName: r.project.name,
      result: r.result,
    });
  }

  // E11 / H7 「加入项目」：暂存成功（或已存在）才跳工作台；满额则只提示、不跳转。
  // 返回 result 让弹窗在满额时停留并提示。
  function handleAddToProject(projectId: string): AddReferenceResult | null {
    const r = stageActiveAsReference(projectId);
    if (!r) return null;
    if (r.result === "full") {
      setStagedNote({
        projectId: r.project.id,
        projectName: r.project.name,
        result: r.result,
      });
      return r.result;
    }
    router.push(`/workspace?project=${r.project.id}`);
    return r.result;
  }

  const stats = [
    { label: "素材总数", value: String(assets.length) },
    { label: "图片", value: String(assets.filter(isImage).length) },
    { label: "已收藏", value: String(assets.filter((a) => a.isFavorite).length) },
    {
      label: "AI 已标注",
      value: String(assets.filter((a) => (a.aiTags?.length ?? 0) > 0).length),
    },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="素材库"
        subtitle="集中管理品牌图片、产品图与参考素材"
        action={
          <div className="flex items-center gap-2">
            <Button
              size="lg"
              variant="outline"
              onClick={() => setCreatingFolder(true)}
            >
              ＋ 新建文件夹
            </Button>
            <Button
              size="lg"
              disabled={upload.isPending}
              onClick={() => {
                setUploadErr(null);
                setUploadDialog(true);
              }}
            >
              {upload.isPending ? "上传中…" : "⬆ 上传素材"}
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)]"
          >
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-3xl font-semibold">{s.value}</div>
          </div>
        ))}
      </div>

      {uploadErr ? (
        <p className="mb-4 text-sm text-destructive">{uploadErr}</p>
      ) : null}

      {/* E3 · 文件夹筛选 */}
      {folders.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">文件夹：</span>
          {[
            { key: "all", label: "全部" },
            { key: "none", label: "未归档" },
            ...folders.map((f) => ({
              key: f.id,
              label: `${f.name}${f.assetCount != null ? ` (${f.assetCount})` : ""}`,
            })),
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFolderFilter(f.key)}
              className={[
                "h-8 rounded-full px-3 text-xs transition-colors",
                folderFilter === f.key
                  ? "bg-accent-soft font-medium text-primary"
                  : "border border-border bg-card text-muted-foreground hover:bg-muted",
              ].join(" ")}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索名称、AI 标签或描述…"
          className="h-10 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
        {/* E13 — favorites-only filter */}
        <button
          onClick={() => setFavOnly((v) => !v)}
          aria-pressed={favOnly}
          className={[
            "h-9 rounded-full px-4 text-sm transition-colors",
            favOnly
              ? "bg-accent-soft font-medium text-primary"
              : "border border-border bg-card text-muted-foreground hover:bg-muted",
          ].join(" ")}
        >
          {favOnly ? "★ 已收藏" : "☆ 收藏"}
        </button>
        {CATEGORIES.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={[
              "h-9 rounded-full px-4 text-sm transition-colors",
              filter === f.value
                ? "bg-accent-soft font-medium text-primary"
                : "border border-border bg-card text-muted-foreground hover:bg-muted",
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="rounded-3xl border border-border bg-card p-16 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : assets.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-16 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-2xl text-primary">
            ▦
          </div>
          <div className="text-lg font-semibold">素材库还是空的</div>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            上传产品图、Logo、参考图，AI 会自动标注，供工作台出图时引用。
          </p>
          <Button
            size="lg"
            className="mt-6"
            onClick={() => {
              setUploadErr(null);
              setUploadDialog(true);
            }}
          >
            ⬆ 上传素材
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {filtered.map((a) => {
              const isActive = a.id === active?.id;
              return (
                <div
                  key={a.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveId(a.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveId(a.id);
                    }
                  }}
                  className={[
                    "flex cursor-pointer flex-col overflow-hidden rounded-3xl border bg-card text-left transition-all",
                    isActive
                      ? "border-primary/40 shadow-[0_18px_50px_rgba(124,92,255,0.12)]"
                      : "border-border shadow-[0_8px_24px_rgba(30,30,60,0.06)] hover:border-primary/25",
                  ].join(" ")}
                >
                  <div className="relative">
                    {isImage(a) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={assetThumbUrl(wsId, a.id, a.url)}
                        alt={a.fileName}
                        className={[
                          "h-32 w-full object-cover",
                          isAvailable(a) ? "" : "opacity-40 grayscale",
                        ].join(" ")}
                      />
                    ) : (
                      <div
                        className={[
                          "flex h-32 items-center justify-center text-3xl text-primary-foreground",
                          isAvailable(a) ? "" : "opacity-40 grayscale",
                        ].join(" ")}
                        style={{ background: gradientFor(a.id) }}
                      >
                        ▦
                      </div>
                    )}
                    {!isAvailable(a) ? (
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-foreground/70 px-2 py-0.5 text-[10px] font-medium text-background">
                        已停用
                      </span>
                    ) : null}
                    {/* E13 · 收藏 toggle star (overlay) */}
                    <button
                      type="button"
                      aria-label={a.isFavorite ? "取消收藏" : "收藏"}
                      aria-pressed={a.isFavorite}
                      disabled={toggleFavorite.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite.mutate(a);
                      }}
                      className={[
                        "absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full text-sm shadow-[0_4px_12px_rgba(30,30,60,0.12)] transition-colors",
                        a.isFavorite
                          ? "bg-accent-soft text-primary"
                          : "bg-card/90 text-muted-foreground hover:text-primary",
                      ].join(" ")}
                    >
                      {a.isFavorite ? "★" : "☆"}
                    </button>
                  </div>
                  <div className="flex flex-col gap-1.5 p-3">
                    <div className="truncate text-xs font-medium">
                      {a.fileName}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Chip>{CAT_LABEL[a.category] ?? a.category}</Chip>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <aside className="sticky top-6 h-fit rounded-3xl border border-border bg-card p-5 shadow-[0_8px_24px_rgba(30,30,60,0.06)]">
            {active ? (
              <>
                {isImage(active) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetThumbUrl(wsId, active.id, active.url)}
                    alt={active.fileName}
                    className="h-44 w-full rounded-2xl object-cover"
                  />
                ) : (
                  <div
                    className="flex h-44 items-center justify-center rounded-2xl text-4xl text-primary-foreground"
                    style={{ background: gradientFor(active.id) }}
                  >
                    ▦
                  </div>
                )}
                <div className="mt-4 flex items-center gap-2 text-sm font-semibold">
                  <span className="truncate">{active.fileName}</span>
                  {!isAvailable(active) ? (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      已停用
                    </span>
                  ) : null}
                  {/* E13 · 收藏 toggle (detail) */}
                  <button
                    type="button"
                    aria-label={active.isFavorite ? "取消收藏" : "收藏"}
                    aria-pressed={active.isFavorite}
                    disabled={toggleFavorite.isPending}
                    onClick={() => toggleFavorite.mutate(active)}
                    className={[
                      "ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm transition-colors",
                      active.isFavorite
                        ? "bg-accent-soft text-primary"
                        : "border border-border text-muted-foreground hover:text-primary",
                    ].join(" ")}
                  >
                    {active.isFavorite ? "★" : "☆"}
                  </button>
                </div>
                {active.aiDescription ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {active.aiDescription}
                  </p>
                ) : null}
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">类型</dt>
                  <dd>{CAT_LABEL[active.category] ?? active.category}</dd>
                  {active.resolution ? (
                    <>
                      <dt className="text-muted-foreground">尺寸</dt>
                      <dd>{active.resolution}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">大小</dt>
                  <dd>{fmtSize(active.sizeBytes)}</dd>
                  <dt className="text-muted-foreground">来源</dt>
                  <dd>{active.source === "WEBSITE" ? "网站采集" : "上传"}</dd>
                </dl>

                {/* H8 · 查看来源 */}
                <Button
                  variant="outline"
                  className="mt-3 w-full rounded-full"
                  onClick={() => setSourceAsset(active)}
                >
                  ⓘ 查看来源
                </Button>

                {/* E13 · 使用记录（真实联动：引用过该素材的出图） */}
                <div className="mt-5 border-t border-border pt-4">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    使用记录
                  </div>
                  {usageLoading ? (
                    <p className="text-xs text-muted-foreground">加载中…</p>
                  ) : usage.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      暂无使用记录。把该素材设为某个 Campaign 的参考并出图后，这里会显示用在哪。
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {usage.map((u) => (
                        <li key={u.generationId}>
                          <a
                            href={`/workspace?project=${u.projectId}`}
                            className="block rounded-2xl border border-border bg-background px-3 py-2 text-xs transition-colors hover:border-primary/25"
                          >
                            <div className="truncate font-medium text-foreground">
                              {u.projectName}
                            </div>
                            <div className="mt-0.5 truncate text-muted-foreground">
                              {u.scene} · {fmtDate(u.usedAt)}
                            </div>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {active.aiTags && active.aiTags.length > 0 ? (
                  <div className="mt-4">
                    <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="text-primary">✦</span> AI 智能标签
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {active.aiTags.map((t) => (
                        <span
                          key={t}
                          className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] text-primary"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* E9/E10 · AI 智能标注 / 生成描述（真异步任务） */}
                {isImage(active) ? (
                  <div className="mt-4">
                    <Button
                      variant="outline"
                      className="w-full rounded-full"
                      disabled={describeBusyHere}
                      onClick={() => {
                        describeFiredFor.current = null;
                        setDescribeTaskId(null);
                        setDescribeTimedOut(false);
                        setDescribeAssetId(active.id);
                        describe.mutate(active.id);
                      }}
                    >
                      {describeBusyHere
                        ? "AI 标注中…"
                        : active.aiTags && active.aiTags.length > 0
                          ? "✦ 重新 AI 标注"
                          : "✦ AI 智能标注 / 生成描述"}
                    </Button>
                    {describeAssetId !== active.id ? null : describeRunning ? (
                      <p className="mt-2 text-center text-xs text-muted-foreground">
                        正在分析素材（{describeTask?.progress ?? 0}%），可离开本页，稍后回来查看。
                      </p>
                    ) : describeTimedOut ? (
                      <p className="mt-2 text-center text-xs text-destructive">
                        分析超时，可能已失败，请重试。
                      </p>
                    ) : describeStatus === "FAILED" ? (
                      <p className="mt-2 text-center text-xs text-destructive">
                        {describeTask?.error ?? "AI 标注失败，请重试。"}
                      </p>
                    ) : describeStatus === "SUCCEEDED" ? (
                      <p className="mt-2 text-center text-xs text-success">
                        ✓ 已生成标签与描述
                      </p>
                    ) : describe.isError ? (
                      <p className="mt-2 text-center text-xs text-destructive">
                        {(describe.error as Error).message}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* E11/E12 · 联动工作台 / Campaign */}
                <div className="mt-5 border-t border-border pt-4">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    用于 Campaign
                  </div>
                  {!isImage(active) ? (
                    <p className="text-xs text-muted-foreground">
                      仅图片素材可设为参考 / 加入项目（PDF·VI 文档等不支持）。
                    </p>
                  ) : !isAvailable(active) ? (
                    <p className="text-xs text-muted-foreground">
                      该素材已停用 / 弃用，不能再用于出图或设为参考。
                    </p>
                  ) : projects.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      还没有 Campaign，先去项目页创建一个。
                    </p>
                  ) : (
                    <>
                      <select
                        value={pickProject}
                        onChange={(e) => {
                          setPickProject(e.target.value);
                          setStagedNote(null);
                        }}
                        className="h-10 w-full rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
                      >
                        <option value="">选择 Campaign…</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <div className="mt-3 flex flex-col gap-2">
                        <Button
                          variant="outline"
                          className="w-full rounded-full"
                          disabled={!pickProject}
                          onClick={handleSetReference}
                        >
                          ✦ 设为参考
                        </Button>
                        <Button
                          className="w-full rounded-full"
                          onClick={() => {
                            setStagedNote(null);
                            setJoinDialog(true);
                          }}
                        >
                          ＋ 加入项目
                        </Button>
                      </div>
                      {stagedNote ? (
                        stagedNote.result === "full" ? (
                          <div className="mt-3 rounded-2xl bg-muted px-3.5 py-2.5 text-xs text-muted-foreground">
                            「{stagedNote.projectName}」的参考素材已满（上限{" "}
                            {REFERENCE_CAP} 个），请先在工作台移除部分再添加。
                          </div>
                        ) : (
                          <div className="mt-3 rounded-2xl bg-accent-soft px-3.5 py-2.5 text-xs text-primary">
                            {stagedNote.result === "duplicate"
                              ? `该素材已在「${stagedNote.projectName}」的参考中。`
                              : `已设为「${stagedNote.projectName}」的参考素材。`}{" "}
                            <a
                              className="font-medium underline underline-offset-2"
                              href={`/workspace?project=${stagedNote.projectId}`}
                            >
                              去工作台查看
                            </a>
                          </div>
                        )
                      ) : null}
                    </>
                  )}
                </div>

                {/* E3 · 移动到文件夹 */}
                <div className="mt-5 border-t border-border pt-4">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    文件夹
                  </div>
                  {folders.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      还没有文件夹。点右上角「新建文件夹」来组织素材。
                    </p>
                  ) : (
                    <select
                      value={active.folderId ?? ""}
                      disabled={moveAsset.isPending}
                      onChange={(e) =>
                        moveAsset.mutate({
                          assetId: active.id,
                          folderId: e.target.value || null,
                        })
                      }
                      className="h-10 w-full rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
                    >
                      <option value="">未归档</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </>
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">
                选择左侧素材查看详情
              </div>
            )}
          </aside>
        </div>
      )}

      {/* E3 · 新建文件夹弹窗 */}
      {creatingFolder ? (
        <CreateFolderDialog
          pending={createFolder.isPending}
          error={createFolder.isError ? (createFolder.error as Error).message : null}
          onClose={() => {
            createFolder.reset();
            setCreatingFolder(false);
          }}
          onCreate={(name) => createFolder.mutate(name)}
        />
      ) : null}

      {/* H6 · 上传素材弹窗 */}
      {uploadDialog ? (
        <UploadDialog
          folders={folders}
          pending={upload.isPending}
          error={uploadErr}
          onClose={() => {
            if (!upload.isPending) setUploadDialog(false);
          }}
          onUpload={(args) => upload.mutate(args)}
        />
      ) : null}

      {/* H8 · 查看来源弹窗 */}
      {sourceAsset ? (
        <ViewSourceDialog
          asset={sourceAsset}
          rawUrl={`/api/workspaces/${wsId}/assets/${sourceAsset.id}/raw`}
          onClose={() => setSourceAsset(null)}
        />
      ) : null}

      {/* H7 · 加入项目弹窗 */}
      {joinDialog && active ? (
        <JoinProjectDialog
          assetName={active.fileName}
          projects={projects}
          initialProjectId={pickProject}
          error={joinError}
          onClose={() => {
            setJoinError(null);
            setJoinDialog(false);
          }}
          onConfirm={(projectId) => {
            setPickProject(projectId);
            const result = handleAddToProject(projectId);
            if (result === "added" || result === "duplicate") {
              // Real success → navigate (handled in handleAddToProject) + close.
              setJoinError(null);
              setJoinDialog(false);
            } else if (result === null) {
              // Staging failed (deactivated asset / non-image) — keep the dialog
              // open and surface why instead of silently "succeeding".
              setJoinError("该素材无法加入：需为可用的图片素材。");
            }
            // "full" → keep open; the staged-full note already explains it.
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * H7 · 加入项目弹窗 — pick a Campaign and confirm adding the selected asset.
 * Honest about what it does: it stages the asset as that Campaign's reference
 * (client-side reference tray; one-期 has no Project↔Asset DB relation) and
 * jumps to the workspace. Reuses the same staging path as the inline action.
 * Semantic tokens only.
 */
function JoinProjectDialog({
  assetName,
  projects,
  initialProjectId,
  error,
  onClose,
  onConfirm,
}: {
  assetName: string;
  projects: Project[];
  initialProjectId: string;
  error?: string | null;
  onClose: () => void;
  onConfirm: (projectId: string) => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">加入 Campaign</div>
        <p className="mt-1 text-sm text-muted-foreground">
          把素材「{assetName}」作为参考加入一个 Campaign，进入工作台出图时自动带入。
        </p>

        <div className="mt-5">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            选择 Campaign
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
          >
            <option value="">选择 Campaign…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <p className="mt-3 rounded-2xl bg-accent-soft/60 p-3.5 text-xs leading-relaxed text-foreground/80">
          素材将作为该 Campaign 的参考素材暂存，出图时随提交带入。确认后将进入工作台。
        </p>

        {error ? (
          <p className="mt-3 text-xs text-destructive">{error}</p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!projectId} onClick={() => onConfirm(projectId)}>
            确认加入
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * E3 · 新建文件夹弹窗 — name a new asset folder. Workspace-scoped real model
 * (AssetFolder); on confirm POSTs to /folders. Semantic tokens only.
 */
function CreateFolderDialog({
  pending,
  error,
  onClose,
  onCreate,
}: {
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">新建文件夹</div>
        <p className="mt-1 text-sm text-muted-foreground">
          为素材建立分组，便于按主题 / Campaign 组织管理。
        </p>
        <div className="mt-5">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            文件夹名称
          </label>
          <input
            autoFocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !pending)
                onCreate(name.trim());
            }}
            placeholder="如：夏季新品素材"
            className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
          />
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!name.trim() || pending}
            onClick={() => onCreate(name.trim())}
          >
            {pending ? "创建中…" : "创建"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * H6 · 上传素材弹窗 — proper dialog with category picker + optional folder +
 * drag/drop or file-picker. Posts to the existing `assets/upload` multipart
 * route via the page's `upload` mutation (REAL R2 upload). VI_DOC restricts the
 * accept to PDF (its parse-manual backend only reads PDF bytes); other
 * categories stay image-only. Semantic tokens only.
 */
function UploadDialog({
  folders,
  pending,
  error,
  onClose,
  onUpload,
}: {
  folders: AssetFolder[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onUpload: (args: {
    file: File;
    category: string;
    folderId: string | null;
  }) => void;
}) {
  const [category, setCategory] = useState("OTHER");
  const [folderId, setFolderId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const accept = category === "VI_DOC" ? "application/pdf" : "image/*";

  function accepts(f: File): boolean {
    if (category === "VI_DOC") return f.type === "application/pdf";
    return f.type.startsWith("image/");
  }
  function pick(f: File | undefined) {
    if (!f) return;
    setFile(accepts(f) ? f : null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">上传素材</div>
        <p className="mt-1 text-sm text-muted-foreground">
          上传产品图、Logo、参考图或 VI 手册（PDF）。上传后 AI 可自动标注，供工作台出图引用。
        </p>

        <input
          ref={fileInput}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        {/* 拖拽 / 点击选择 */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInput.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pick(e.dataTransfer.files?.[0]);
          }}
          className={[
            "mt-5 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors",
            dragOver
              ? "border-primary/50 bg-accent-soft"
              : "border-border bg-background hover:border-primary/30",
          ].join(" ")}
        >
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-xl text-primary">
            ⬆
          </div>
          {file ? (
            <span className="truncate text-sm font-medium text-foreground">
              {file.name}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              拖拽文件到此，或点击选择
            </span>
          )}
          <span className="mt-1 text-xs text-muted-foreground">
            {category === "VI_DOC" ? "仅 PDF" : "图片格式"}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              分类
            </label>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                // changing the accept type may invalidate the picked file.
                setFile((f) => (f && (e.target.value === "VI_DOC"
                  ? f.type === "application/pdf"
                  : f.type.startsWith("image/"))
                  ? f
                  : null));
              }}
              className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            >
              {CATEGORIES.filter((c) => c.value !== "all").map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              文件夹（可选）
            </label>
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
            >
              <option value="">未归档</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!file || pending}
            onClick={() =>
              file &&
              onUpload({ file, category, folderId: folderId || null })
            }
          >
            {pending ? "上传中…" : "上传"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * H8 · 查看来源弹窗 — shows the asset's REAL provenance + metadata (source,
 * original url, created time, mime type, size) and a link to open the original
 * bytes via the same-origin raw proxy. No fabrication — every field comes off
 * the Asset row. Semantic tokens only.
 */
function ViewSourceDialog({
  asset,
  rawUrl,
  onClose,
}: {
  asset: Asset;
  rawUrl: string;
  onClose: () => void;
}) {
  const rows: { label: string; value: string }[] = [
    { label: "文件名", value: asset.fileName },
    {
      label: "来源",
      value: asset.source === "WEBSITE" ? "网站采集" : "上传",
    },
    { label: "类型", value: CAT_LABEL[asset.category] ?? asset.category },
    { label: "格式", value: asset.mimeType || "—" },
    { label: "大小", value: fmtSize(asset.sizeBytes) },
    ...(asset.resolution
      ? [{ label: "尺寸", value: asset.resolution }]
      : []),
    { label: "创建时间", value: fmtDate(asset.createdAt) },
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">素材来源</div>
        <p className="mt-1 text-sm text-muted-foreground">
          {asset.source === "WEBSITE"
            ? "该素材由网站采集而来。"
            : "该素材由本地上传而来。"}
        </p>

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
          {rows.map((r) => (
            <Fragment key={r.label}>
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="truncate">{r.value}</dd>
            </Fragment>
          ))}
          {asset.source === "WEBSITE" && asset.url ? (
            <>
              <dt className="text-muted-foreground">原始链接</dt>
              <dd className="truncate">
                <a
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-primary underline underline-offset-2"
                >
                  {asset.url}
                </a>
              </dd>
            </>
          ) : null}
        </dl>

        <div className="mt-6 flex justify-end gap-2">
          <a href={rawUrl} target="_blank" rel="noreferrer noopener">
            <Button variant="outline">查看原图</Button>
          </a>
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}
