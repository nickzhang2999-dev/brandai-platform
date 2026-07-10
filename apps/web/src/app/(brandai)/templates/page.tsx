"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Asset } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { validateImageUploadFile } from "@/lib/upload-limits";
import { PageHeader } from "../_ui";
import { useBrand } from "../brand-context";

/**
 * V0.0.9 · 模板库 = 参考图图库。这里的图片只用于 AI 工作台的风格、色系、
 * 比例、构图参考，不会作为水印/素材叠加到最终图。
 */
export default function TemplatesPage() {
  const { wsId } = useBrand();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["brandai-assets", wsId, "templates"],
    queryFn: () =>
      apiFetch<Asset[]>(`/api/workspaces/${wsId}/assets?libraryKind=TEMPLATE`),
  });

  async function upload(file: File) {
    setUploading(true);
    setErr(null);
    try {
      validateImageUploadFile(file);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "OTHER");
      fd.append("libraryKind", "TEMPLATE");
      const res = await fetch(`/api/workspaces/${wsId}/assets/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "上传失败");
      }
      qc.invalidateQueries({ queryKey: ["brandai-assets", wsId] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageHeader
        title="模板库"
        subtitle="沉淀参考图；在 AI 工作台中只参考风格、色系、比例与构图"
        action={
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "上传中…" : "+ 上传参考图"}
          </Button>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <div className="mb-6 rounded-2xl border border-primary/15 bg-accent-soft/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        模板库与素材库分离：模板图不会被放到最终画面上，只作为 AI 出图的视觉参考。
      </div>

      {err ? <p className="mb-4 text-sm text-destructive">{err}</p> : null}

      {isLoading ? (
        <div className="rounded-3xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center">
          <div className="text-lg font-semibold">模板库还是空的</div>
          <p className="mt-2 text-sm text-muted-foreground">
            上传参考图后，就可以在 AI 工作台中作为风格参考调用。
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((asset) => (
            <div
              key={asset.id}
              className="overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetThumbUrl(wsId, asset.id, asset.url)}
                alt={asset.fileName}
                className="h-44 w-full object-cover"
              />
              <div className="p-5">
                <div className="truncate text-sm font-semibold">
                  {asset.fileName}
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {asset.aiDescription || "参考图：用于风格、色系、比例与构图参考。"}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(asset.tags ?? []).slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] text-primary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
