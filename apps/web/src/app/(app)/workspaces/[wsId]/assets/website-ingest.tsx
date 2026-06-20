"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AssetCategory,
  type Asset,
  type IngestWebsiteResponse,
} from "@brandai/contracts";
import {
  Button,
  Input,
  Spinner,
  Badge,
  FieldLabel,
  Eyebrow,
  StyleTag,
  ColorSwatch,
} from "@brandai/ui";
import { apiFetch, CATEGORY_LABELS, CATEGORY_ORDER } from "@/lib/client";

export function WebsiteIngest({
  wsId,
  defaultUrl,
  onDone,
}: {
  wsId: string;
  defaultUrl: string;
  onDone: () => void;
}) {
  const [url, setUrl] = useState(defaultUrl);
  const [result, setResult] = useState<IngestWebsiteResponse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [category, setCategory] = useState<AssetCategory>("OTHER");
  const [error, setError] = useState<string | null>(null);

  const ingest = useMutation({
    mutationFn: () =>
      apiFetch<IngestWebsiteResponse>(`/api/workspaces/${wsId}/ingest`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: wsId, url }),
      }),
    onSuccess: (r) => {
      setResult(r);
      setSelected(new Set());
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "读取失败"),
  });

  const save = useMutation({
    mutationFn: () => {
      const images = (result?.images ?? []).filter((_, i) =>
        selected.has(i),
      );
      return apiFetch<Asset[]>(`/api/workspaces/${wsId}/ingest`, {
        method: "PUT",
        body: JSON.stringify({ images, category }),
      });
    },
    onSuccess: () => {
      setResult(null);
      setSelected(new Set());
      onDone();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "保存失败"),
  });

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <FieldLabel>品牌官网 · SOURCE URL</FieldLabel>
        <form
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            ingest.mutate();
          }}
        >
          <Input
            type="url"
            required
            value={url}
            placeholder="https://品牌官网.com"
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={ingest.isPending || !url}>
            {ingest.isPending ? <Spinner /> : null}
            读取
          </Button>
        </form>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {ingest.isPending ? (
        <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-foreground/15 bg-muted/40 px-6 py-16 text-center">
          <Spinner />
          <p className="font-serif text-lg text-foreground/80">
            正在读取官网视觉…
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            抓取候选图片、卖点与文案,稍候片刻。
          </p>
        </div>
      ) : null}

      {result ? (
        <>
          {result.siteStyle &&
          ((result.siteStyle.palette?.length ?? 0) > 0 ||
            (result.siteStyle.fonts?.length ?? 0) > 0 ||
            result.siteStyle.logoUrl ||
            result.siteStyle.siteName) ? (
            <div className="flex flex-col gap-4 rounded-3xl border border-foreground/10 bg-card p-6 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <Eyebrow tone="accent">SITE STYLE · 检测到的站点视觉</Eyebrow>
                {result.siteStyle.siteName ? (
                  <span className="truncate font-serif text-base text-foreground/80">
                    {result.siteStyle.siteName}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-start gap-x-10 gap-y-5">
                {result.siteStyle.logoUrl ? (
                  <div className="flex flex-col gap-2">
                    <FieldLabel>LOGO</FieldLabel>
                    <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-foreground/10 bg-background p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={result.siteStyle.logoUrl}
                        alt="logo"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                  </div>
                ) : null}
                {(result.siteStyle.palette?.length ?? 0) > 0 ? (
                  <div className="flex flex-col gap-2">
                    <FieldLabel>色彩 · PALETTE</FieldLabel>
                    <div className="flex flex-wrap gap-3">
                      {result.siteStyle.palette.map((hex) => (
                        <ColorSwatch key={hex} hex={hex} />
                      ))}
                    </div>
                  </div>
                ) : null}
                {(result.siteStyle.fonts?.length ?? 0) > 0 ? (
                  <div className="flex flex-col gap-2">
                    <FieldLabel>字体 · TYPEFACE</FieldLabel>
                    <div className="flex flex-wrap gap-2">
                      {result.siteStyle.fonts.map((f) => (
                        <StyleTag key={f}>{f}</StyleTag>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                选中候选图入库后,到「风格规则」发起识别,即可把这套视觉沉淀为可确认的品牌规则。
              </p>
            </div>
          ) : null}

          {result.images.length > 0 ? (
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {result.images.map((img, i) => {
                  const on = selected.has(i);
                  return (
                    <button
                      type="button"
                      key={img.sourceUrl + i}
                      onClick={() => toggle(i)}
                      className={`group relative flex flex-col gap-2.5 overflow-hidden rounded-2xl border bg-card p-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md ${
                        on
                          ? "border-accent ring-2 ring-accent/40"
                          : "border-foreground/10"
                      }`}
                    >
                      <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img.previewUrl}
                          alt={img.guessedCategory ?? "官网候选图片"}
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                        {on ? (
                          <span className="absolute right-2 top-2">
                            <Badge tone="strong">已选</Badge>
                          </span>
                        ) : null}
                      </div>
                      {img.guessedCategory ? (
                        <span className="px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                          {img.guessedCategory}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-foreground/10 pt-5">
                <select
                  value={category}
                  onChange={(e) =>
                    setCategory(e.target.value as AssetCategory)
                  }
                  className="h-10 rounded-xl border border-foreground/15 bg-background px-4 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {CATEGORY_ORDER.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c] ?? c}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={selected.size === 0 || save.isPending}
                  onClick={() => {
                    setError(null);
                    save.mutate();
                  }}
                >
                  {save.isPending ? <Spinner /> : null}
                  入库选中 ({selected.size})
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-muted/40 px-6 py-16 text-center">
              <Eyebrow tone="accent">NO CANDIDATES</Eyebrow>
              <p className="font-serif text-lg text-foreground/80">
                未抓到候选图片
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                换一个更具体的页面地址,或改用文件上传。
              </p>
            </div>
          )}

          {result.sellingPoints.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <FieldLabel>卖点候选 · M3 生成可用</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {result.sellingPoints.map((sp, i) => (
                  <StyleTag key={i}>{sp}</StyleTag>
                ))}
              </div>
            </div>
          ) : null}
          {result.copies.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <FieldLabel>文案候选 · COPY</FieldLabel>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {result.copies.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
