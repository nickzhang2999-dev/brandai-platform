"use client";

import { useState } from "react";
import { Badge, Button, CreamCard, Spinner } from "@brandai/ui";

/**
 * Admin control for the self-serve registration switch. Default CLOSED — only a
 * platform admin can open public sign-ups. PATCHes /api/admin/registration and
 * renders from the server's returned state.
 */
export function RegistrationToggle({ initialOpen }: { initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/registration", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ registrationOpen: !open }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `操作失败 (${res.status})`);
      setOpen(!!body.registrationOpen);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CreamCard className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 font-medium text-foreground">
            公开注册
            {open ? (
              <Badge tone="pass">已开放</Badge>
            ) : (
              <Badge tone="danger">已关闭</Badge>
            )}
          </div>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            关闭后,新访客无法自助注册(管理员白名单 ADMIN_EMAILS
            与首位管理员引导不受影响,始终可注册)。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {busy ? <Spinner /> : null}
          <Button variant="outline" size="sm" disabled={busy} onClick={toggle}>
            {open ? "关闭注册" : "开放注册"}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </CreamCard>
  );
}
