"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Asset, Project } from "@brandai/contracts";
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

function fmtSize(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function isImage(a: Asset): boolean {
  return (a.mimeType ?? "").startsWith("image/");
}

export default function AssetsPage() {
  const { wsId } = useBrand();
  const qc = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Upload category picker — lets users create non-image assets too (notably
  // VI_DOC/PDF, which the 手册解析(D14) flow needs). Defaults to OTHER.
  const [uploadCategory, setUploadCategory] = useState("OTHER");
  const uploadAccept =
    uploadCategory === "VI_DOC" ? "application/pdf,image/*" : "image/*";
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  // E11/E12 · 参考素材联动：选中的目标 Campaign + 暂存确认提示。
  const [pickProject, setPickProject] = useState("");
  const [stagedNote, setStagedNote] = useState<{
    projectId: string;
    projectName: string;
    result: AddReferenceResult;
  } | null>(null);

  const { data: assets = [], isLoading } = useQuery({
    queryKey: ["brandai-assets", wsId],
    queryFn: () => apiFetch<Asset[]>(`/api/workspaces/${wsId}/assets`),
  });

  // 共享 ["brandai-projects", wsId] 缓存（与首页/工作台/项目页同 key）。
  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", uploadCategory);
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
      setActiveId(a.id);
      setUploadErr(null);
    },
    onError: (e) => setUploadErr((e as Error).message),
  });

  const filtered = useMemo(
    () =>
      assets.filter((a) => {
        if (filter !== "all" && a.category !== filter) return false;
        if (q && !a.fileName.toLowerCase().includes(q.toLowerCase()))
          return false;
        return true;
      }),
    [assets, filter, q],
  );
  const active = filtered.find((a) => a.id === activeId) ?? filtered[0] ?? assets[0];

  // E11/E12 · 把当前选中素材暂存为目标 Campaign 的参考素材（client-side staging，
  // 一期无 Project↔Asset DB 关系，暂存于 reference-tray，工作台出图时读取）。
  function stageActiveAsReference(
    projectId: string,
  ): { project: Project; result: AddReferenceResult } | null {
    if (!active || !projectId) return null;
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

  // E11 「加入项目」：暂存成功（或已存在）才跳工作台；满额则只提示、不跳转。
  function handleAddToProject() {
    const r = stageActiveAsReference(pickProject);
    if (!r) return;
    if (r.result === "full") {
      setStagedNote({
        projectId: r.project.id,
        projectName: r.project.name,
        result: r.result,
      });
      return;
    }
    router.push(`/workspace?project=${r.project.id}`);
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
      <input
        ref={fileInput}
        type="file"
        accept={uploadAccept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />
      <PageHeader
        title="素材库"
        subtitle="集中管理品牌图片、产品图与参考素材"
        action={
          <div className="flex items-center gap-2">
            <select
              value={uploadCategory}
              onChange={(e) => setUploadCategory(e.target.value)}
              disabled={upload.isPending}
              aria-label="上传分类"
              className="h-11 rounded-full border border-border bg-card px-4 text-sm text-foreground"
            >
              {CATEGORIES.filter((c) => c.value !== "all").map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <Button
              size="lg"
              disabled={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending
                ? "上传中…"
                : uploadCategory === "VI_DOC"
                  ? "⬆ 上传 PDF/VI 手册"
                  : "⬆ 上传素材"}
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

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索素材名称…"
          className="h-10 flex-1 rounded-full border border-border bg-card px-4 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
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
            onClick={() => fileInput.current?.click()}
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
                <button
                  key={a.id}
                  onClick={() => setActiveId(a.id)}
                  className={[
                    "flex flex-col overflow-hidden rounded-3xl border bg-card text-left transition-all",
                    isActive
                      ? "border-primary/40 shadow-[0_18px_50px_rgba(124,92,255,0.12)]"
                      : "border-border shadow-[0_8px_24px_rgba(30,30,60,0.06)] hover:border-primary/25",
                  ].join(" ")}
                >
                  {isImage(a) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetThumbUrl(wsId, a.id, a.url)}
                      alt={a.fileName}
                      className="h-32 w-full object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-32 items-center justify-center text-3xl text-primary-foreground"
                      style={{ background: gradientFor(a.id) }}
                    >
                      ▦
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5 p-3">
                    <div className="truncate text-xs font-medium">
                      {a.fileName}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Chip>{CAT_LABEL[a.category] ?? a.category}</Chip>
                    </div>
                  </div>
                </button>
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
                <div className="mt-4 text-sm font-semibold">
                  {active.fileName}
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

                {/* E11/E12 · 联动工作台 / Campaign */}
                <div className="mt-5 border-t border-border pt-4">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    用于 Campaign
                  </div>
                  {projects.length === 0 ? (
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
                          disabled={!pickProject}
                          onClick={handleAddToProject}
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
              </>
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">
                选择左侧素材查看详情
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
