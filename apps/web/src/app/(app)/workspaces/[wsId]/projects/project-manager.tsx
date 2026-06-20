"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Project } from "@brandai/contracts";
import {
  Button,
  Input,
  Label,
  Spinner,
  Panel,
  SectionHeading,
  StyleTag,
  Eyebrow,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";

/**
 * M6 · 项目组织 — list / create / edit projects and filter+group them by
 * 活动(campaign) / 商品(product) / 渠道(channel). Drilling into a project
 * card navigates to its generation records page. Reads go through the
 * additive server helper `listWorkspaceProjects`; mutations hit the
 * `POST /projects` route (validated by `CreateProjectInput`).
 */

type Draft = {
  id?: string;
  name: string;
  campaign: string;
  product: string;
  channel: string;
};

const EMPTY: Draft = {
  name: "",
  campaign: "",
  product: "",
  channel: "",
};

type GroupBy = "none" | "campaign" | "product" | "channel";

const GROUP_LABEL: Record<Exclude<GroupBy, "none">, string> = {
  campaign: "活动",
  product: "商品",
  channel: "渠道",
};

export function ProjectManager({
  wsId,
  initialProjects,
}: {
  wsId: string;
  initialProjects: Project[];
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");

  const { data: projects = initialProjects } = useQuery({
    queryKey: ["projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
    initialData: initialProjects,
  });

  const save = useMutation({
    mutationFn: (d: Draft) =>
      apiFetch<Project>(`/api/workspaces/${wsId}/projects`, {
        method: d.id ? "PATCH" : "POST",
        body: JSON.stringify({
          ...(d.id ? { id: d.id } : {}),
          name: d.name,
          campaign: d.campaign || undefined,
          product: d.product || undefined,
          channel: d.channel || undefined,
        }),
      }),
    onSuccess: () => {
      setDraft(EMPTY);
      setError(null);
      qc.invalidateQueries({ queryKey: ["projects", wsId] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "保存失败"),
  });

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      [p.name, p.campaign, p.product, p.channel]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    );
  }, [projects, filter]);

  const groups = useMemo(() => {
    if (groupBy === "none") {
      return [{ key: "全部项目", items: filtered }];
    }
    const map = new Map<string, Project[]>();
    for (const p of filtered) {
      const key = (p[groupBy] as string | undefined) || "（未设置）";
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "zh"))
      .map(([key, items]) => ({ key, items }));
  }, [filtered, groupBy]);

  return (
    <div className="flex flex-col gap-10">
      <Panel className="flex flex-col gap-6">
        <SectionHeading
          eyebrow="PROJECT · 项目组织"
          title={draft.id ? "编辑项目" : "新建项目"}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label>项目名称 *</Label>
            <Input
              value={draft.name}
              onChange={(e) =>
                setDraft({ ...draft, name: e.target.value })
              }
              placeholder="2025 春季新品 KV"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>活动 Campaign</Label>
            <Input
              value={draft.campaign}
              onChange={(e) =>
                setDraft({ ...draft, campaign: e.target.value })
              }
              placeholder="春季焕新"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>商品 Product</Label>
            <Input
              value={draft.product}
              onChange={(e) =>
                setDraft({ ...draft, product: e.target.value })
              }
              placeholder="精华水"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>渠道 Channel</Label>
            <Input
              value={draft.channel}
              onChange={(e) =>
                setDraft({ ...draft, channel: e.target.value })
              }
              placeholder="天猫 / 小红书"
            />
          </div>
        </div>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!draft.name.trim() || save.isPending}
            onClick={() => {
              setError(null);
              save.mutate(draft);
            }}
          >
            {save.isPending ? <Spinner /> : null}
            {draft.id ? "保存修改" : "创建项目"}
          </Button>
          {draft.id ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(EMPTY)}
            >
              取消
            </Button>
          ) : null}
        </div>
      </Panel>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label>筛选</Label>
          <Input
            className="w-full sm:w-80"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按名称 / 活动 / 商品 / 渠道筛选"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Eyebrow>分组方式 · GROUP BY</Eyebrow>
          <div className="flex flex-wrap gap-2">
            {(["none", "campaign", "product", "channel"] as const).map(
              (g) => {
                const on = groupBy === g;
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGroupBy(g)}
                    className={`rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-wide transition-colors ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-foreground/15 bg-muted text-foreground/70 hover:border-accent"
                    }`}
                  >
                    {g === "none" ? "不分组" : GROUP_LABEL[g]}
                  </button>
                );
              },
            )}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-foreground/15 bg-card/50 px-6 py-16 text-center">
          <p className="font-serif text-xl text-foreground/80">还没有项目</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            在生成向导（M3）或上方表单创建一个项目后，生成记录会归集到这里。
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-5">
            {groupBy !== "none" ? (
              <div className="flex items-baseline gap-3 border-b border-foreground/10 pb-2">
                <Eyebrow tone="accent">
                  {GROUP_LABEL[groupBy as Exclude<GroupBy, "none">]}
                </Eyebrow>
                <h2 className="font-serif text-xl">{group.key}</h2>
                <span className="font-mono text-xs text-muted-foreground">
                  {group.items.length}
                </span>
              </div>
            ) : null}
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {group.items.map((p) => (
                <div
                  key={p.id}
                  className="group flex flex-col gap-4 rounded-2xl border border-foreground/10 bg-card p-6 shadow-sm transition-colors hover:border-accent"
                >
                  <Link
                    href={`/workspaces/${wsId}/projects/${p.id}`}
                    className="flex flex-col gap-3"
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                      {new Date(p.createdAt).toLocaleDateString("zh-CN")}
                    </span>
                    <div className="font-serif text-2xl leading-tight">
                      {p.name}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {p.campaign ? (
                        <StyleTag>活动 · {p.campaign}</StyleTag>
                      ) : null}
                      {p.product ? (
                        <StyleTag>商品 · {p.product}</StyleTag>
                      ) : null}
                      {p.channel ? (
                        <StyleTag>渠道 · {p.channel}</StyleTag>
                      ) : null}
                    </div>
                  </Link>
                  <div className="mt-auto flex items-center gap-3 border-t border-foreground/10 pt-4">
                    <Link
                      href={`/workspaces/${wsId}/projects/${p.id}`}
                      className="font-mono text-xs uppercase tracking-wide text-primary transition-colors hover:text-primary/80"
                    >
                      查看生成记录 →
                    </Link>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({
                          id: p.id,
                          name: p.name,
                          campaign: p.campaign ?? "",
                          product: p.product ?? "",
                          channel: p.channel ?? "",
                        })
                      }
                      className="ml-auto font-mono text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                    >
                      编辑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
