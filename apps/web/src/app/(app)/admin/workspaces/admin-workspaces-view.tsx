"use client";

import { useState } from "react";
import Link from "next/link";
import { CreamCard } from "@brandai/ui";
import type {
  AdminWorkspaceSummary,
} from "@brandai/contracts";
import type { AdminWork } from "@/lib/admin-workspaces";
import { WorksPlaza } from "./works-plaza";

/**
 * Two-tab admin view of /admin/workspaces:
 *   - 目录 · catalog (existing read-only workspace table)
 *   - 作品广场 · gallery (every GenerationVersion across all spaces, newest
 *     first, click any image for a lightbox showing applied rules)
 *
 * Server fetches both payloads in parallel; this client component just toggles
 * between them so the route is one DB roundtrip.
 */
type Tab = "catalog" | "gallery";

export function AdminWorkspacesView({
  workspaces,
  works,
}: {
  workspaces: AdminWorkspaceSummary[];
  works: AdminWork[];
}) {
  const [tab, setTab] = useState<Tab>("catalog");
  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {(
          [
            { value: "catalog", label: "目录", count: workspaces.length, suffix: "空间" },
            { value: "gallery", label: "作品广场", count: works.length, suffix: "件作品" },
          ] as const
        ).map((t) => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={
                "rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-[0.15em] transition-colors " +
                (active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-foreground/15 text-foreground/70 hover:bg-muted")
              }
            >
              {t.label}
              <span className="ml-2 text-foreground/40">
                {t.count} {t.suffix}
              </span>
            </button>
          );
        })}
      </div>

      {tab === "catalog" ? (
        <CreamCard className="mt-6 overflow-x-auto p-0">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-left font-mono text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 font-medium">空间 / 行业</th>
                <th className="px-5 py-3 font-medium">所有者</th>
                <th className="px-5 py-3 font-medium">成员</th>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">规则</th>
                <th className="px-5 py-3 font-medium">项目</th>
                <th className="px-5 py-3 font-medium">生成</th>
                <th className="px-5 py-3 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr
                  key={w.id}
                  className="border-b border-foreground/5 align-middle last:border-0 hover:bg-foreground/[0.03]"
                >
                  <td className="px-5 py-4">
                    <Link
                      href={`/admin/workspaces/${w.id}`}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {w.name}
                    </Link>
                    {w.industry ? (
                      <div className="text-xs text-muted-foreground">
                        {w.industry}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-4">
                    <div className="text-foreground">{w.ownerEmail}</div>
                    {w.ownerName ? (
                      <div className="text-xs text-muted-foreground">
                        {w.ownerName}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-4 tabular-nums">{w.memberCount}</td>
                  <td className="px-5 py-4 tabular-nums">{w.assetCount}</td>
                  <td className="px-5 py-4 tabular-nums">{w.ruleCount}</td>
                  <td className="px-5 py-4 tabular-nums">{w.projectCount}</td>
                  <td className="px-5 py-4 tabular-nums">
                    {w.generationCount}
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted-foreground">
                    {w.createdAt.slice(0, 10)}
                  </td>
                </tr>
              ))}
              {workspaces.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-5 py-10 text-center text-sm text-muted-foreground"
                  >
                    暂无品牌空间
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CreamCard>
      ) : (
        <div className="mt-6">
          <WorksPlaza works={works} />
        </div>
      )}
    </>
  );
}
