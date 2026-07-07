"use client";

import { useState } from "react";
import type { AdminUserSummary } from "@brandai/contracts";
import { Badge, Button, CreamCard, Spinner } from "@brandai/ui";

function quotaLabel(u: AdminUserSummary): string {
  const daily =
    u.dailyGenerationLimit < 0 ? "∞" : String(u.dailyGenerationLimit);
  const monthly =
    u.monthlyGenerationQuota < 0 ? "∞" : String(u.monthlyGenerationQuota);
  return `${daily}/日 · ${monthly}/月`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

export function UsersTable({
  initial,
  currentUserId,
}: {
  initial: AdminUserSummary[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<AdminUserSummary[]>(initial);
  // Per-row busy id so two actions can't fire at once on the same user.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mutations return the refreshed list from the server (the single source of
  // truth) — we render straight from that rather than patching local state.
  async function run(
    userId: string,
    init: RequestInit,
  ): Promise<void> {
    setBusyId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surface the backend's real message (真实错误透传).
        throw new Error(body?.error ?? `操作失败 (${res.status})`);
      }
      if (Array.isArray(body?.users)) setUsers(body.users as AdminUserSummary[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  function toggleActive(u: AdminUserSummary) {
    return run(u.id, {
      method: "PATCH",
      body: JSON.stringify({ isActive: !u.isActive }),
    });
  }

  function remove(u: AdminUserSummary) {
    const ok = window.confirm(
      `确认删除账号「${u.email}」?\n\n这会连同其 ${u.workspaceCount} 个品牌空间及全部资产/规则/生成记录一并删除,不可恢复。`,
    );
    if (!ok) return;
    return run(u.id, { method: "DELETE" });
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="text-xs text-muted-foreground">
        共 {users.length} 个账号
      </div>

      <CreamCard className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-foreground/10 text-left font-mono text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-3 font-medium">邮箱 / 名称</th>
              <th className="px-5 py-3 font-medium">品牌空间</th>
              <th className="px-5 py-3 font-medium">订阅额度</th>
              <th className="px-5 py-3 font-medium">注册时间</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === currentUserId;
              const busy = busyId === u.id;
              return (
                <tr
                  key={u.id}
                  className="border-b border-foreground/5 align-middle last:border-0"
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      {u.email}
                      {u.isAdmin ? <Badge tone="strong">管理员</Badge> : null}
                      {isSelf ? <Badge tone="weak">当前账号</Badge> : null}
                    </div>
                    {u.name ? (
                      <div className="text-xs text-muted-foreground">
                        {u.name}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-4 tabular-nums">{u.workspaceCount}</td>
                  <td className="px-5 py-4">
                    <span className="font-mono text-xs text-muted-foreground">
                      {u.planTier}
                    </span>
                    <div className="text-xs text-muted-foreground">
                      {quotaLabel(u)}
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted-foreground">
                    {fmtDate(u.createdAt)}
                  </td>
                  <td className="px-5 py-4">
                    {u.isActive ? (
                      <Badge tone="pass">已启用</Badge>
                    ) : (
                      <Badge tone="danger">已禁用</Badge>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center justify-end gap-2">
                      {busy ? <Spinner /> : null}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isSelf || busy}
                        title={isSelf ? "不能操作自己的账号" : undefined}
                        onClick={() => toggleActive(u)}
                      >
                        {u.isActive ? "禁用" : "启用"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={isSelf || busy}
                        title={isSelf ? "不能删除自己的账号" : undefined}
                        onClick={() => remove(u)}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-10 text-center text-sm text-muted-foreground"
                >
                  暂无注册用户
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CreamCard>
    </div>
  );
}
