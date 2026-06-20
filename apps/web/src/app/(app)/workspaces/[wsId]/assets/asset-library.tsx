"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Asset } from "@brandai/contracts";
import { Panel, Spinner } from "@brandai/ui";
import { cn } from "@brandai/ui";
import { apiFetch, CATEGORY_LABELS, CATEGORY_ORDER } from "@/lib/client";
import { AssetUploader } from "./asset-uploader";
import { WebsiteIngest } from "./website-ingest";
import { AssetGrid } from "./asset-grid";

type Tab = "upload" | "ingest";

export function AssetLibrary({
  wsId,
  defaultWebsiteUrl,
}: {
  wsId: string;
  defaultWebsiteUrl: string;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("upload");
  const [filter, setFilter] = useState<string>("ALL");

  const assetsKey = ["assets", wsId, filter];
  const { data: assets, isLoading } = useQuery({
    queryKey: assetsKey,
    queryFn: () =>
      apiFetch<Asset[]>(
        `/api/workspaces/${wsId}/assets${
          filter === "ALL" ? "" : `?category=${filter}`
        }`,
      ),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["assets", wsId] });

  return (
    <div className="flex flex-col gap-8">
      <Panel>
        <div className="mb-6 inline-flex gap-1 rounded-full border border-foreground/10 bg-muted/50 p-1">
          <PillTab active={tab === "upload"} onClick={() => setTab("upload")}>
            上传文件
          </PillTab>
          <PillTab active={tab === "ingest"} onClick={() => setTab("ingest")}>
            从官网读取
          </PillTab>
        </div>
        {tab === "upload" ? (
          <AssetUploader wsId={wsId} onDone={invalidate} />
        ) : (
          <WebsiteIngest
            wsId={wsId}
            defaultUrl={defaultWebsiteUrl}
            onDone={invalidate}
          />
        )}
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          label={`全部 (${assets?.length ?? 0})`}
          active={filter === "ALL"}
          onClick={() => setFilter("ALL")}
        />
        {CATEGORY_ORDER.map((c) => (
          <FilterChip
            key={c}
            label={CATEGORY_LABELS[c] ?? c}
            active={filter === c}
            onClick={() => setFilter(c)}
          />
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> 加载资产中…
        </div>
      ) : (
        <AssetGrid
          wsId={wsId}
          assets={assets ?? []}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}

function PillTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-5 py-2 font-mono text-xs uppercase tracking-[0.18em] transition-colors",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-foreground/15 bg-muted text-foreground/80 hover:border-accent",
      )}
    >
      {label}
    </button>
  );
}
