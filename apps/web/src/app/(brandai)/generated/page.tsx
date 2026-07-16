"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { GeneratedAsset, Project } from "@brandai/contracts";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { useMemo, useState } from "react";
import { PageHeader } from "../_ui";
import { useBrand } from "../brand-context";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
};

const SCENE_LABELS: Record<string, string> = {
  ECOM_MAIN: "电商主图",
  SCENE: "场景图",
  SOCIAL_POSTER: "社媒海报",
  CAMPAIGN_KV: "Campaign KV",
  SELLING_POINT: "卖点图",
};

/**
 * V0.10 · 生成图 = AI 工作台产出的 GENERATED 镜像。
 *
 * GenerationVersion 仍是权威记录；这里展示的是回流到 Asset 的统一检索视图，
 * 并按项目维度提供搜索、筛选和回跳。
 */
export default function GeneratedImagesPage() {
  const { wsId, brandName } = useBrand();
  const [q, setQ] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [projectStatus, setProjectStatus] = useState("all");
  const [range, setRange] = useState("all");
  const [sort, setSort] = useState("recent");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (projectId !== "all") params.set("projectId", projectId);
    if (projectStatus !== "all") params.set("projectStatus", projectStatus);
    if (range !== "all") params.set("range", range);
    if (sort !== "recent") params.set("sort", sort);
    const suffix = params.toString();
    return suffix ? `?${suffix}` : "";
  }, [projectId, projectStatus, q, range, sort]);

  const { data: images = [], isLoading } = useQuery({
    queryKey: ["brandai-generated-assets", wsId, query],
    queryFn: () =>
      apiFetch<GeneratedAsset[]>(
        `/api/workspaces/${wsId}/generated-assets${query}`,
      ),
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId, "generated-filter"],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="生成图"
        subtitle="集中查看当前品牌套件下的生成图，并按项目维度快速检索"
      />

      <div className="mb-5 rounded-2xl border border-primary/15 bg-accent-soft/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        当前品牌套件：{brandName}。生成图来自该品牌套件下各项目的 AI
        工作台历史出图与终稿镜像，权威记录仍保留在对应项目的出图版本中。
      </div>

      <div className="mb-6 rounded-3xl border border-border bg-card p-4 shadow-[0_10px_28px_rgba(30,30,60,0.05)]">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1.6fr)_1fr_1fr_1fr_1fr]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
              查询
            </span>
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="搜索文件名、描述、项目或提示词..."
              className="h-11 w-full rounded-full border border-border bg-background px-4 text-sm outline-none transition focus:border-primary focus:ring-4 focus:ring-ring/20"
            />
          </label>

          <FilterSelect
            label="项目"
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: "all", label: "全部项目" },
              ...projects.map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
          />

          <FilterSelect
            label="项目状态"
            value={projectStatus}
            onChange={setProjectStatus}
            options={[
              { value: "all", label: "全部状态" },
              { value: "IN_PROGRESS", label: "进行中" },
              { value: "DRAFT", label: "草稿" },
              { value: "COMPLETED", label: "已完成" },
            ]}
          />

          <FilterSelect
            label="生成时间"
            value={range}
            onChange={setRange}
            options={[
              { value: "all", label: "全部时间" },
              { value: "7", label: "近 7 天" },
              { value: "30", label: "近 30 天" },
              { value: "90", label: "近 90 天" },
            ]}
          />

          <FilterSelect
            label="排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: "recent", label: "最近生成" },
              { value: "oldest", label: "最早生成" },
              { value: "project", label: "项目名称" },
              { value: "fileName", label: "文件名" },
            ]}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-xs text-muted-foreground">
            当前显示{" "}
            <span className="font-semibold text-foreground">
              {images.length}
            </span>{" "}
            张生成图
          </div>
          <button
            type="button"
            onClick={() => {
              setQ("");
              setProjectId("all");
              setProjectStatus("all");
              setRange("all");
              setSort("recent");
            }}
            className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-primary"
          >
            清空筛选
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-3xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : images.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center">
          <div className="text-lg font-semibold">还没有生成图</div>
          <p className="mt-2 text-sm text-muted-foreground">
            在 AI 工作台完成出图后，系统会把结果镜像到这里。
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {images.map((asset) => (
            <article
              key={asset.id}
              className="overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetThumbUrl(wsId, asset.id, asset.url)}
                alt={asset.fileName}
                className="h-48 w-full object-cover"
              />
              <div className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {asset.fileName}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {asset.createdAt
                        ? new Date(asset.createdAt).toLocaleString()
                        : ""}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-medium text-primary">
                    生成图
                  </span>
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {asset.aiDescription ||
                    "AI 工作台生成结果，可回到项目历史出图继续编辑、终选或导出。"}
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-full bg-muted px-2.5 py-1">
                    {asset.projectName ?? "未关联项目"}
                  </span>
                  {asset.projectStatus ? (
                    <span className="rounded-full bg-accent-soft px-2.5 py-1 text-primary">
                      {STATUS_LABELS[asset.projectStatus] ??
                        asset.projectStatus}
                    </span>
                  ) : null}
                  {asset.sceneType ? (
                    <span className="rounded-full bg-muted px-2.5 py-1">
                      {SCENE_LABELS[asset.sceneType] ?? asset.sceneType}
                    </span>
                  ) : null}
                </div>
                {asset.projectId ? (
                  <Link
                    href={`/workspace?project=${asset.projectId}`}
                    className="mt-4 inline-flex rounded-full border border-primary/20 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-accent-soft"
                  >
                    回到项目工作台
                  </Link>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full rounded-full border border-border bg-background px-4 text-sm outline-none transition focus:border-primary focus:ring-4 focus:ring-ring/20"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
