"use client";

import { useState } from "react";
import { Button, CreamCard, Input, Label } from "@brandai/ui";

/**
 * Change own password. Posts to /api/me/password, which verifies the current
 * password before writing the new one. Confirm field is a client-side guard
 * (the server only needs current + new). Real backend errors are surfaced.
 */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next.length < 8) {
      setError("新密码至少 8 位");
      return;
    }
    if (next !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/me/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `操作失败 (${res.status})`);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CreamCard className="p-5">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="current">当前密码</Label>
          <Input
            id="current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="next">新密码(至少 8 位)</Label>
          <Input
            id="next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm">确认新密码</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {done ? (
          <div className="rounded-xl border border-success/40 bg-success/10 px-4 py-2 text-sm text-success">
            密码已更新。
          </div>
        ) : null}

        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "提交中…" : "更新密码"}
          </Button>
        </div>
      </form>
    </CreamCard>
  );
}
