"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  InvitableRole,
  ListMembersResponse,
  MemberSummary,
  WorkspaceRole,
} from "@brandai/contracts";
import {
  Button,
  Badge,
  Input,
  Spinner,
  Panel,
  SectionHeading,
  FieldLabel,
} from "@brandai/ui";
import { apiFetch } from "@/lib/client";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "所有者",
  EDITOR: "编辑",
  REVIEWER: "审核",
  VIEWER: "查看",
};
const ROLE_HINT: Record<string, string> = {
  EDITOR: "编辑 · 可生成 / 送审",
  REVIEWER: "审核 · 可批准 / 驳回",
  VIEWER: "查看 · 只读",
};
const INVITABLE: InvitableRole[] = ["EDITOR", "REVIEWER", "VIEWER"];

export function MembersPanel({
  wsId,
  initialMembers,
  myRole,
  currentUserId,
}: {
  wsId: string;
  initialMembers: MemberSummary[];
  myRole: WorkspaceRole;
  currentUserId: string;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("EDITOR");
  const [error, setError] = useState<string | null>(null);
  const isOwner = myRole === "OWNER";

  const { data: members = initialMembers } = useQuery({
    queryKey: ["members", wsId],
    queryFn: () =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members`).then(
        (r) => r.members,
      ),
    initialData: initialMembers,
  });

  function apply(body: ListMembersResponse | { members: MemberSummary[] }) {
    qc.setQueryData(["members", wsId], (body as { members: MemberSummary[] }).members);
  }

  const invite = useMutation({
    mutationFn: () =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      }),
    onSuccess: (r) => {
      setEmail("");
      setError(null);
      apply(r);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: InvitableRole }) =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members/${v.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: v.role }),
      }),
    onSuccess: apply,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members/${userId}`, {
        method: "DELETE",
      }),
    onSuccess: apply,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col gap-8">
      {isOwner ? (
        <Panel className="flex flex-col gap-4">
          <SectionHeading eyebrow="INVITE · 邀请成员" title="邀请协作者" />
          <p className="text-sm text-muted-foreground">
            输入对方邮箱(需已注册)并指定角色。重复邀请将更新其角色。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
              <FieldLabel>邮箱</FieldLabel>
              <Input
                type="email"
                autoComplete="off"
                value={email}
                placeholder="teammate@brand.co"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>角色</FieldLabel>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as InvitableRole)}
                className="h-10 rounded-xl border border-foreground/15 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {INVITABLE.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_HINT[r]}
                  </option>
                ))}
              </select>
            </div>
            <Button
              disabled={!email.trim() || invite.isPending}
              onClick={() => invite.mutate()}
            >
              {invite.isPending ? <Spinner /> : null}
              邀请
            </Button>
          </div>
          {error ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </Panel>
      ) : null}

      <section className="flex flex-col gap-4">
        <SectionHeading
          eyebrow={`MEMBERS · ${members.length} 人`}
          title="成员列表"
        />
        <div className="overflow-x-auto rounded-2xl border border-foreground/10 bg-card">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-left font-mono text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 font-medium">邮箱 / 名称</th>
                <th className="px-5 py-3 font-medium">角色</th>
                <th className="px-5 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.userId === currentUserId;
                const busy =
                  (changeRole.isPending && changeRole.variables?.userId === m.userId) ||
                  (remove.isPending && remove.variables === m.userId);
                return (
                  <tr key={m.userId} className="border-b border-foreground/5 last:border-0">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        {m.email}
                        {m.isOwner ? <Badge tone="strong">所有者</Badge> : null}
                        {isSelf ? <Badge tone="weak">我</Badge> : null}
                      </div>
                      {m.name ? (
                        <div className="text-xs text-muted-foreground">{m.name}</div>
                      ) : null}
                    </td>
                    <td className="px-5 py-4">
                      {isOwner && !m.isOwner ? (
                        <select
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            changeRole.mutate({
                              userId: m.userId,
                              role: e.target.value as InvitableRole,
                            })
                          }
                          className="h-9 rounded-lg border border-foreground/15 bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {INVITABLE.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge tone="neutral">{ROLE_LABEL[m.role] ?? m.role}</Badge>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {busy ? <Spinner /> : null}
                        {isOwner && !m.isOwner ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(`移除成员「${m.email}」?`))
                                remove.mutate(m.userId);
                            }}
                          >
                            移除
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
