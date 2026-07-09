"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Generation, Project, SceneType, SizeSpec } from "@brandai/contracts";
import { CHANNEL_SIZES } from "@brandai/contracts";
import {
  Button,
  Badge,
  Textarea,
  Spinner,
  Panel,
  SectionHeading,
  FieldLabel,
  MiniStat,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";

const SCENE_TYPES: { value: SceneType; label: string }[] = [
  { value: "ECOM_MAIN", label: "电商主图" },
  { value: "SCENE", label: "场景图" },
  { value: "SOCIAL_POSTER", label: "社媒海报" },
  { value: "CAMPAIGN_KV", label: "活动 KV" },
  { value: "SELLING_POINT", label: "产品卖点图" },
];

interface CampaignScene {
  sceneType: string;
  generation: Generation;
  jobId?: string;
}

/**
 * E8 Campaign Kit — one brief → a whole set of channel materials. Pick N scene
 * types × M channel sizes, one selling point/scene, and fan out a Generation
 * per scene (each producing one image per size) under one Project.
 */
export function CampaignKit({
  wsId,
  initialProjects,
  confirmedRuleCount,
}: {
  wsId: string;
  initialProjects: Project[];
  confirmedRuleCount: number;
}) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(
    initialProjects[0]?.id ?? null,
  );
  const [scenes, setScenes] = useState<Set<SceneType>>(new Set());
  const [sizeKeys, setSizeKeys] = useState<Set<string>>(new Set());
  const [sellingPoint, setSellingPoint] = useState("");
  const [scene, setScene] = useState("");
  const [campaign, setCampaign] = useState<CampaignScene[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: projects = initialProjects } = useQuery({
    queryKey: ["projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
    initialData: initialProjects,
  });

  const targets: SizeSpec[] = useMemo(
    () => CHANNEL_SIZES.filter((s) => sizeKeys.has(s.key)),
    [sizeKeys],
  );

  // Poll every scene's generation until all terminate.
  const genIds = campaign?.map((c) => c.generation.id) ?? [];
  const { data: gens } = useQuery({
    queryKey: ["campaign", wsId, genIds.join(",")],
    enabled: genIds.length > 0,
    refetchInterval: (q) => {
      const list = q.state.data as Generation[] | undefined;
      if (!list) return 1500;
      return list.every((g) => g.status === "SUCCEEDED" || g.status === "FAILED")
        ? false
        : 1500;
    },
    queryFn: () =>
      Promise.all(
        genIds.map((id) =>
          apiFetch<{ generation: Generation }>(
            `/api/workspaces/${wsId}/generations/${id}`,
          ).then((r) => r.generation),
        ),
      ),
  });

  const submit = useMutation({
    mutationFn: () =>
      apiFetch<{ projectId: string; scenes: CampaignScene[] }>(
        `/api/workspaces/${wsId}/campaigns`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            sellingPoint,
            scene,
            scenes: [...scenes],
            targets,
          }),
        },
      ),
    onSuccess: (r) => {
      setError(null);
      setCampaign(r.scenes);
      qc.invalidateQueries({ queryKey: ["campaign", wsId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  function toggleScene(s: SceneType) {
    setScenes((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  }
  function toggleSize(k: string) {
    setSizeKeys((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }

  const canRun =
    !!projectId &&
    scenes.size > 0 &&
    targets.length > 0;
  const totalImages = scenes.size * targets.length;

  const allDone =
    !!gens && gens.every((g) => g.status === "SUCCEEDED" || g.status === "FAILED");

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-2xl border border-foreground/10 bg-card/40 px-6 py-5">
        <div className="grid grid-cols-3 gap-6">
          <MiniStat label="SCENES" value={scenes.size} hint="场景类型" />
          <MiniStat label="CHANNELS" value={targets.length} hint="渠道尺寸" />
          <MiniStat label="OUTPUT" value={totalImages} hint="本套总图数" />
        </div>
      </div>

      {!campaign ? (
        <Panel className="flex flex-col gap-6">
          <SectionHeading
            eyebrow="CAMPAIGN KIT · 活动物料包"
            title="一次产出整套渠道物料"
          />
          <p className="text-sm text-muted-foreground">
            一个创意简报,跨多个场景类型 × 多个渠道尺寸,一次生成整套并归入同一项目,
            可在「项目与版本」按整套打包导出。共享同一品牌规则约束(已确认 {confirmedRuleCount} 条)。
          </p>

          {/* Project */}
          <div className="flex flex-col gap-2">
            <FieldLabel>项目 · PROJECT</FieldLabel>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                还没有项目,请先在「单次生成」里新建一个项目。
              </p>
            ) : (
              <select
                value={projectId ?? ""}
                onChange={(e) => setProjectId(e.target.value || null)}
                className="h-10 w-full max-w-md rounded-xl border border-foreground/15 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Scene types */}
          <div className="flex flex-col gap-3">
            <FieldLabel>场景类型 · SCENES(多选)</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {SCENE_TYPES.map((t) => {
                const on = scenes.has(t.value);
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => toggleScene(t.value)}
                    className={`rounded-full border px-4 py-1.5 text-sm transition ${
                      on
                        ? "border-accent bg-accent text-ink"
                        : "border-foreground/15 text-muted-foreground hover:border-accent"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Channel sizes */}
          <div className="flex flex-col gap-3">
            <FieldLabel>渠道尺寸 · CHANNELS(多选)</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {CHANNEL_SIZES.map((s) => {
                const on = sizeKeys.has(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => toggleSize(s.key)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      on
                        ? "border-accent bg-accent text-ink"
                        : "border-foreground/15 text-muted-foreground hover:border-accent"
                    }`}
                  >
                    {s.label} · {s.width}×{s.height}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Brief */}
          <div className="flex flex-col gap-2">
            <FieldLabel>核心卖点 · SELLING POINT</FieldLabel>
            <Textarea
              value={sellingPoint}
              placeholder="例如：72 小时长效保湿，敏感肌可用"
              onChange={(e) => setSellingPoint(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <FieldLabel>场景描述 · SCENE</FieldLabel>
            <Textarea
              value={scene}
              placeholder="例如：清晨浴室台面，自然光，水珠质感"
              onChange={(e) => setScene(e.target.value)}
            />
          </div>

          <div>
            <Button disabled={!canRun || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? <Spinner /> : null}
              生成整套({scenes.size} 场景 × {targets.length} 尺寸 = {totalImages} 张)
            </Button>
          </div>
          {error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </Panel>
      ) : (
        <Panel className="flex flex-col gap-6">
          <SectionHeading
            eyebrow="RESULT · 整套结果"
            title="活动物料包"
            action={
              <Button variant="ghost" size="sm" onClick={() => setCampaign(null)}>
                新建一套
              </Button>
            }
          />
          {!allDone ? (
            <div className="flex items-center gap-3 rounded-2xl border border-foreground/10 bg-muted px-5 py-4">
              <Spinner />
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                生成中 · {(gens ?? []).filter((g) => g.status === "SUCCEEDED").length} /{" "}
                {genIds.length} 场景完成
              </span>
            </div>
          ) : (
            <div className="rounded-2xl border border-success/30 bg-success/10 px-5 py-3 text-sm text-success">
              整套生成完成。可前往「项目与版本」选择版本、按整套打包导出交付。
            </div>
          )}

          <div className="flex flex-col gap-6">
            {campaign.map((c, i) => {
              const g = gens?.[i] ?? c.generation;
              const label =
                SCENE_TYPES.find((s) => s.value === c.sceneType)?.label ??
                c.sceneType;
              const versions = g.versions ?? [];
              return (
                <div key={c.generation.id} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-serif text-lg">{label}</span>
                    {g.status === "SUCCEEDED" ? (
                      <Badge tone="pass">{versions.length} 张</Badge>
                    ) : g.status === "FAILED" ? (
                      <Badge tone="danger">失败</Badge>
                    ) : (
                      <Badge tone="neutral">生成中</Badge>
                    )}
                  </div>
                  {versions.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {versions.map((v) => {
                        const p = (v.params ?? {}) as Record<string, unknown>;
                        const sizeLabel =
                          typeof p.targetLabel === "string"
                            ? (p.targetLabel as string)
                            : `${v.width}×${v.height}`;
                        return (
                          <figure
                            key={v.id}
                            className="flex flex-col gap-1.5 overflow-hidden rounded-2xl border border-foreground/10 bg-muted p-2"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={v.imageUrl}
                              alt={sizeLabel}
                              className="aspect-square w-full rounded-xl object-cover"
                            />
                            <figcaption className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                              {sizeLabel} · {v.width}×{v.height}
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  ) : g.status === "FAILED" ? (
                    <p className="text-sm text-destructive">
                      该场景生成失败：{g.error ?? "未知错误"}
                    </p>
                  ) : (
                    <div className="h-24 rounded-2xl border border-dashed border-foreground/15 bg-muted/40" />
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}
