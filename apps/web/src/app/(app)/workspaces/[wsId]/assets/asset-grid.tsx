"use client";

import { useMutation } from "@tanstack/react-query";
import { AssetCategory, type Asset } from "@brandai/contracts";
import { Button, VisualAssetCard, Eyebrow } from "@brandai/ui";
import {
  apiFetch,
  assetThumbUrl,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
} from "@/lib/client";

type AssetWithLifecycle = Asset & {
  availableForGeneration?: boolean;
  deprecatedAt?: string | null;
};

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function AssetGrid({
  wsId,
  assets,
  onChanged,
}: {
  wsId: string;
  assets: AssetWithLifecycle[];
  onChanged: () => void;
}) {
  const update = useMutation({
    mutationFn: (v: {
      id: string;
      body: Partial<{
        category: AssetCategory;
        availableForGeneration: boolean;
        deprecatedAt: string | null;
      }>;
    }) =>
      apiFetch<Asset>(`/api/workspaces/${wsId}/assets/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify(v.body),
      }),
    onSuccess: onChanged,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean }>(`/api/workspaces/${wsId}/assets/${id}`, {
        method: "DELETE",
      }),
    onSuccess: onChanged,
  });

  if (assets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-20 text-center">
        <Eyebrow tone="accent">EMPTY GALLERY</Eyebrow>
        <p className="font-serif text-xl text-foreground/80">还没有资产</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          先上传品牌素材,或从官网读取候选图片,建立你的视觉资产底座。
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {assets.map((a) => {
        const deprecated = !!a.deprecatedAt;
        const available = a.availableForGeneration !== false && !deprecated;
        const tags = [
          CATEGORY_LABELS[a.category] ?? a.category,
          a.source === "WEBSITE" ? "官网" : "上传",
          available ? "可生成" : deprecated ? "已废弃" : "停用",
        ];
        const metaBits = [formatSize(a.sizeBytes), formatDate(a.createdAt)].filter(
          Boolean,
        );
        return (
          <div key={a.id} className="flex flex-col gap-2.5">
            <div className={deprecated ? "opacity-50 grayscale" : ""}>
              <VisualAssetCard
                name={a.fileName}
                thumbUrl={assetThumbUrl(wsId, a.id, a.url)}
                tags={tags}
                meta={metaBits.join(" · ")}
              />
            </div>

            <select
              value={a.category}
              onChange={(e) =>
                update.mutate({
                  id: a.id,
                  body: { category: e.target.value as AssetCategory },
                })
              }
              className="h-9 w-full rounded-xl border border-foreground/15 bg-background px-3 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c] ?? c}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    id: a.id,
                    body: { availableForGeneration: !available },
                  })
                }
              >
                {available ? "停用" : "启用"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    id: a.id,
                    body: {
                      deprecatedAt: deprecated ? null : new Date().toISOString(),
                    },
                  })
                }
              >
                {deprecated ? "恢复" : "标为废弃"}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate(a.id)}
            >
              删除
            </Button>
          </div>
        );
      })}
    </div>
  );
}
