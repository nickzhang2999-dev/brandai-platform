"use client";

import { useRef, useState, type FormEvent } from "react";
import type { AdminUserSummary } from "@brandai/contracts";
import { Badge, Button, CreamCard, Input } from "@brandai/ui";

export function UsersTable({ initial, currentUserId }: {
  initial: AdminUserSummary[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState(initial);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<AdminUserSummary | null>(null);
  const createDialog = useRef<HTMLDialogElement>(null);
  const freezeDialog = useRef<HTMLDialogElement>(null);
  const search = query.trim().toLowerCase();
  const visible = users.filter(user => `${user.name ?? ""} ${user.email}`.toLowerCase().includes(search));

  async function save(path: string, method: "POST" | "PATCH", input: object, success: string) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/admin/users${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (response.status === 422) throw new Error("请检查姓名、邮箱和密码格式。");
      if (!response.ok || !Array.isArray(body.users)) throw new Error(body.error ?? "操作失败，请重试。");
      setUsers(body.users);
      setMessage(success);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    if (await save("", "POST", data, "账号已创建。")) {
      form.reset();
      setQuery("");
      createDialog.current?.close();
    }
  }

  async function setActive(user: AdminUserSummary, isActive: boolean) {
    if (await save(`/${encodeURIComponent(user.id)}`, "PATCH", { isActive },
      isActive ? "账号已恢复，可以重新登录。" : "账号已冻结。")) {
      freezeDialog.current?.close();
    }
  }

  const dialogClass = "w-[min(28rem,calc(100%-2rem))] rounded-3xl border border-border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">账号管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">创建登录账号，冻结或恢复账号的登录资格。</p>
        </div>
        <Button type="button" disabled={busy} onClick={() => { setError(""); createDialog.current?.showModal(); }}>创建账号</Button>
      </header>
      <CreamCard className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 p-4">
          <Input className="max-w-xs" type="search" aria-label="搜索账号" placeholder="搜索姓名或邮箱" value={query} onChange={event => setQuery(event.target.value)} />
          <span className="shrink-0 text-sm text-muted-foreground">{visible.length} 个账号</span>
        </div>
        <table className="w-full text-left text-sm">
          <thead><tr className="border-y border-border text-muted-foreground">
            <th scope="col" className="p-3">账号</th><th scope="col" className="p-3">状态</th><th scope="col" className="p-3 text-right">操作</th>
          </tr></thead>
          <tbody>{visible.map(user => (
            <tr key={user.id} className="border-b border-border last:border-b-0">
              <td className="break-all p-3"><div className="font-medium">{user.name || user.email}{user.id === currentUserId ? "（当前账号）" : ""}</div><div className="text-muted-foreground">{user.email}</div></td>
              <td className="whitespace-nowrap p-3"><Badge>{user.isActive ? "正常" : "已冻结"}</Badge></td>
              <td className="p-3 text-right"><Button variant="outline" size="sm" disabled={busy || user.id === currentUserId}
                aria-label={`${user.isActive ? "冻结" : "恢复"} ${user.email}`}
                onClick={() => {
                  if (!user.isActive) { void setActive(user, true); return; }
                  setError(""); setTarget(user); freezeDialog.current?.showModal();
                }}>{user.isActive ? "冻结" : "恢复"}</Button></td>
            </tr>
          ))}</tbody>
        </table>
        {!visible.length && <p className="p-5 text-center text-sm text-muted-foreground">没有匹配的账号</p>}
      </CreamCard>
      <p role="status" className="text-sm text-primary">{message}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <dialog ref={createDialog} className={dialogClass} aria-labelledby="create-account-title" onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => setError("")}>
        <form className="space-y-4" onSubmit={create}>
          <h2 id="create-account-title" className="text-xl font-semibold">创建账号</h2>
          <label className="block text-sm">姓名<Input name="name" required maxLength={40} /></label>
          <label className="block text-sm">登录邮箱<Input name="email" type="email" required maxLength={120} /></label>
          <label className="block text-sm">初始密码<Input name="password" type="password" minLength={8} maxLength={128} required autoComplete="new-password" /></label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" disabled={busy} onClick={() => createDialog.current?.close()}>取消</Button>
            <Button type="submit" disabled={busy}>{busy ? "创建中…" : "创建"}</Button>
          </div>
        </form>
      </dialog>
      <dialog ref={freezeDialog} className={dialogClass} aria-labelledby="freeze-account-title" onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => setError("")}>
        <h2 id="freeze-account-title" className="text-xl font-semibold">冻结账号</h2>
        <p className="mt-2 text-sm text-muted-foreground">冻结后，{target?.email} 将无法登录，已有会话也会失效。</p>
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" type="button" disabled={busy} onClick={() => freezeDialog.current?.close()}>取消</Button>
          <Button type="button" disabled={busy || !target} onClick={() => target && void setActive(target, false)}>{busy ? "冻结中…" : "确认冻结"}</Button>
        </div>
      </dialog>
    </div>
  );
}
