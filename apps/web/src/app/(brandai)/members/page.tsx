"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  InvitableRole,
  ListMembersResponse,
  MemberSummary,
  WorkspaceRole,
} from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch } from "@/lib/client";
import { useBrand } from "../brand-context";
import { PageHeader } from "../_ui";

/**
 * G6 · 成员 / 协作管理 — 团队成员列表 + OWNER 邀请/改角色/移除。全部接真实
 * workspace 作用域 BFF：
 *   GET    /api/workspaces/[wsId]/members            列出成员 + 自己的角色
 *   POST   /api/workspaces/[wsId]/members            邀请已注册用户（OWNER）
 *   PATCH  /api/workspaces/[wsId]/members/[userId]   改角色（OWNER）
 *   DELETE /api/workspaces/[wsId]/members/[userId]   移除（OWNER）
 * 非 OWNER 看到只读列表；后端错误（如「该邮箱尚未注册」）原样诚实呈现。
 * 紫色设计语言：语义 token only。
 */

// 角色可读标签 + 简介（rank: OWNER > EDITOR > REVIEWER > VIEWER）。
const ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: "所有者",
  EDITOR: "编辑",
  REVIEWER: "审核",
  VIEWER: "查看",
};

const ROLE_DESC: Record<WorkspaceRole, string> = {
  OWNER: "空间所有者，拥有全部权限（含成员管理、计费）。",
  EDITOR: "可创建 / 出图 / 改图，并把版本提交审阅。",
  REVIEWER: "可审阅版本（批准 / 驳回），但不创建内容。",
  VIEWER: "只读：可浏览品牌、项目与已出图内容。",
};

// 可邀请角色（排除 OWNER，所有权转移不在范围内）。
const INVITABLE_ROLES: InvitableRole[] = ["EDITOR", "REVIEWER", "VIEWER"];

function RoleBadge({ role }: { role: WorkspaceRole }) {
  // OWNER 用主色实底，其余用 lavender 软底，全圆 chip。
  const cls =
    role === "OWNER"
      ? "bg-primary text-primary-foreground"
      : "bg-accent-soft text-primary";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}

function initialsOf(m: MemberSummary): string {
  const base = (m.name ?? m.email).trim();
  return base ? base.slice(0, 1).toUpperCase() : "?";
}

export default function MembersPage() {
  const { wsId } = useBrand();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["brandai-members", wsId],
    queryFn: () =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members`),
    enabled: !!wsId,
  });

  const members = data?.members ?? [];
  const myRole = data?.myRole;
  const isOwner = myRole === "OWNER";

  const [inviteOpen, setInviteOpen] = useState(false);
  // 改角色 / 移除的目标成员（弹窗）。
  const [roleTarget, setRoleTarget] = useState<MemberSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MemberSummary | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["brandai-members", wsId] });

  // 邀请成员（POST /members）。后端错误（404「该邮箱尚未注册」等）冒泡到弹窗。
  const inviteMutation = useMutation({
    mutationFn: (input: { email: string; role: InvitableRole }) =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      invalidate();
      setInviteOpen(false);
    },
  });

  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: InvitableRole }) =>
      apiFetch<ListMembersResponse>(
        `/api/workspaces/${wsId}/members/${input.userId}`,
        { method: "PATCH", body: JSON.stringify({ role: input.role }) },
      ),
    onSuccess: () => {
      invalidate();
      setRoleTarget(null);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<ListMembersResponse>(
        `/api/workspaces/${wsId}/members/${userId}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      invalidate();
      setRemoveTarget(null);
    },
  });

  const subtitle = useMemo(() => {
    if (members.length <= 1) return "邀请同事进入本品牌空间，分配协作角色。";
    return `本品牌空间共 ${members.length} 位成员。`;
  }, [members.length]);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <PageHeader
        title="成员协作"
        subtitle={subtitle}
        action={
          isOwner ? (
            <Button onClick={() => setInviteOpen(true)}>邀请成员</Button>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="rounded-3xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          加载成员中…
        </div>
      ) : error ? (
        <div className="rounded-3xl border border-destructive/30 bg-destructive/5 p-10 text-center text-sm text-destructive">
          {error instanceof Error ? error.message : "成员加载失败"}
        </div>
      ) : (
        <div className="overflow-hidden rounded-3xl border border-border bg-card">
          {members.map((m, i) => (
            <div
              key={m.userId}
              className={[
                "flex items-center gap-4 px-5 py-4",
                i > 0 ? "border-t border-border" : "",
              ].join(" ")}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-sm font-semibold text-primary-foreground">
                {initialsOf(m)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {m.name ?? m.email}
                  </span>
                  {m.isOwner ? (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                      创建者
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {m.email}
                </div>
              </div>
              <RoleBadge role={m.role} />
              {isOwner && !m.isOwner ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRoleTarget(m)}
                    className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    改角色
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(m)}
                    className="rounded-full border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
                  >
                    移除
                  </button>
                </div>
              ) : null}
            </div>
          ))}

          {members.length <= 1 ? (
            <div className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground">
              目前只有你一人。
              {isOwner
                ? "点击右上角「邀请成员」邀请同事加入协作。"
                : ""}
            </div>
          ) : null}
        </div>
      )}

      {/* 角色说明卡 — 帮助理解 RBAC 分工，纯展示。 */}
      <div className="mt-6 rounded-3xl border border-border bg-card p-5">
        <div className="mb-3 text-sm font-semibold">角色权限</div>
        <dl className="grid gap-2.5 text-sm sm:grid-cols-2">
          {(Object.keys(ROLE_LABELS) as WorkspaceRole[]).map((r) => (
            <div key={r} className="flex items-start gap-2.5">
              <RoleBadge role={r} />
              <span className="text-xs leading-relaxed text-muted-foreground">
                {ROLE_DESC[r]}
              </span>
            </div>
          ))}
        </dl>
      </div>

      {inviteOpen ? (
        <InviteDialog
          submitting={inviteMutation.isPending}
          error={
            inviteMutation.error instanceof Error
              ? inviteMutation.error.message
              : null
          }
          onCancel={() => {
            inviteMutation.reset();
            setInviteOpen(false);
          }}
          onSubmit={(email, role) => inviteMutation.mutate({ email, role })}
        />
      ) : null}

      {roleTarget ? (
        <RoleDialog
          member={roleTarget}
          submitting={roleMutation.isPending}
          error={
            roleMutation.error instanceof Error
              ? roleMutation.error.message
              : null
          }
          onCancel={() => {
            roleMutation.reset();
            setRoleTarget(null);
          }}
          onSubmit={(role) =>
            roleMutation.mutate({ userId: roleTarget.userId, role })
          }
        />
      ) : null}

      {removeTarget ? (
        <ConfirmRemoveDialog
          member={removeTarget}
          submitting={removeMutation.isPending}
          error={
            removeMutation.error instanceof Error
              ? removeMutation.error.message
              : null
          }
          onCancel={() => {
            removeMutation.reset();
            setRemoveTarget(null);
          }}
          onConfirm={() => removeMutation.mutate(removeTarget.userId)}
        />
      ) : null}
    </div>
  );
}

/** 邀请已注册用户（email + 角色）。后端 404「该邮箱尚未注册」等错误诚实呈现。 */
function InviteDialog({
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (email: string, role: InvitableRole) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("EDITOR");
  const valid = /\S+@\S+\.\S+/.test(email.trim());

  return (
    <DialogShell onClose={onCancel}>
      <div className="text-lg font-semibold">邀请成员</div>
      <p className="mt-1 text-sm text-muted-foreground">
        对方需先注册 BrandAI 账号，再用其邮箱邀请进入本品牌空间。
      </p>

      <div className="mt-5">
        <label className="mb-2 block text-sm font-medium">成员邮箱</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.com"
          className="h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
      </div>

      <div className="mt-4">
        <label className="mb-2 block text-sm font-medium">协作角色</label>
        <div className="flex flex-wrap gap-1.5">
          {INVITABLE_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={[
                "rounded-full px-3 py-1.5 text-xs transition-colors",
                role === r
                  ? "bg-accent-soft font-medium text-primary"
                  : "border border-border text-muted-foreground hover:bg-muted",
              ].join(" ")}
            >
              {ROLE_LABELS[r]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {ROLE_DESC[role]}
        </p>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-destructive">{error}</p>
      ) : null}

      <DialogActions
        onCancel={onCancel}
        confirmLabel={submitting ? "邀请中…" : "发送邀请"}
        confirmDisabled={!valid || submitting}
        onConfirm={() => onSubmit(email.trim(), role)}
      />
    </DialogShell>
  );
}

/** 改角色（PATCH /members/[userId]）。 */
function RoleDialog({
  member,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  member: MemberSummary;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (role: InvitableRole) => void;
}) {
  const initial: InvitableRole = INVITABLE_ROLES.includes(
    member.role as InvitableRole,
  )
    ? (member.role as InvitableRole)
    : "VIEWER";
  const [role, setRole] = useState<InvitableRole>(initial);

  return (
    <DialogShell onClose={onCancel}>
      <div className="text-lg font-semibold">修改角色</div>
      <p className="mt-1 text-sm text-muted-foreground">
        为 <span className="font-medium text-foreground">{member.name ?? member.email}</span> 设置协作角色。
      </p>

      <div className="mt-5 flex flex-col gap-2">
        {INVITABLE_ROLES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            className={[
              "flex items-start gap-3 rounded-2xl border p-3 text-left transition-colors",
              role === r
                ? "border-primary/40 bg-accent-soft/50"
                : "border-border hover:bg-muted",
            ].join(" ")}
          >
            <RoleBadge role={r} />
            <span className="text-xs leading-relaxed text-muted-foreground">
              {ROLE_DESC[r]}
            </span>
          </button>
        ))}
      </div>

      {error ? (
        <p className="mt-3 text-sm text-destructive">{error}</p>
      ) : null}

      <DialogActions
        onCancel={onCancel}
        confirmLabel={submitting ? "保存中…" : "保存"}
        confirmDisabled={submitting || role === member.role}
        onConfirm={() => onSubmit(role)}
      />
    </DialogShell>
  );
}

/** 移除成员确认（DELETE /members/[userId]）。 */
function ConfirmRemoveDialog({
  member,
  submitting,
  error,
  onCancel,
  onConfirm,
}: {
  member: MemberSummary;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell onClose={onCancel}>
      <div className="text-lg font-semibold">移除成员</div>
      <p className="mt-2 text-sm text-muted-foreground">
        确认将{" "}
        <span className="font-medium text-foreground">
          {member.name ?? member.email}
        </span>{" "}
        移出本品牌空间？对方将立即失去访问权限，可日后重新邀请。
      </p>

      {error ? (
        <p className="mt-3 text-sm text-destructive">{error}</p>
      ) : null}

      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting}
          className="rounded-full bg-destructive px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-destructive/90 disabled:opacity-70"
        >
          {submitting ? "移除中…" : "确认移除"}
        </button>
      </div>
    </DialogShell>
  );
}

/** 弹窗外壳 — backdrop + 圆角卡片，匹配工作台弹窗 idiom，语义 token only。 */
function DialogShell({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function DialogActions({
  onCancel,
  onConfirm,
  confirmLabel,
  confirmDisabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled: boolean;
}) {
  return (
    <div className="mt-6 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
      >
        取消
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={confirmDisabled}
        className="rounded-full bg-gradient-to-br from-primary to-accent px-5 py-2 text-sm font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.24)] disabled:opacity-70"
      >
        {confirmLabel}
      </button>
    </div>
  );
}
