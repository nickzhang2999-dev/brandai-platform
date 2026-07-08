"use client";

import { useQuery } from "@tanstack/react-query";
import type { Asset } from "@brandai/contracts";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { PageHeader } from "../_ui";
import { useBrand } from "../brand-context";

/**
 * V0.0.9 · 生成图 = AI 工作台产出的 GENERATED 镜像。
 *
 * GenerationVersion 仍是权威记录；这里展示的是回流到 Asset 的统一检索视图，
 * 避免生成图混入素材库默认列表。
 */
export default function GeneratedImagesPage() {
  const { wsId } = useBrand();
  const { data: images = [], isLoading } = useQuery({
    queryKey: ["brandai-assets", wsId, "generated"],
    queryFn: () =>
      apiFetch<Asset[]>(`/api/workspaces/${wsId}/assets?libraryKind=GENERATED`),
  });

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="生成图"
        subtitle="集中查看 AI 工作台确认后的生成图；这些图片不会混入素材库默认列表"
      />

      <div className="mb-6 rounded-2xl border border-primary/15 bg-accent-soft/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        生成图来自 AI 工作台的历史出图与终稿镜像，权威记录仍保留在对应项目的出图版本中。
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
                      {asset.createdAt ? new Date(asset.createdAt).toLocaleString() : ""}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-medium text-primary">
                    生成图
                  </span>
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {asset.aiDescription || "AI 工作台生成结果，可回到项目历史出图继续编辑、终选或导出。"}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
