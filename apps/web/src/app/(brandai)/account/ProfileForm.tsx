"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";

export function ProfileForm({
  email,
  initialName,
}: {
  email: string;
  initialName: string;
}) {
  const router = useRouter();
  const fallbackName = email.split("@")[0] || "用户";
  const [name, setName] = useState(initialName || fallbackName);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = name.trim();
    if (!next) {
      setError("昵称不能为空");
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await apiFetch("/api/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      });
      setMessage("昵称已保存，首页欢迎语会同步更新。");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <label className="block text-sm font-medium text-foreground">
        昵称
        <input
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 h-11 w-full rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
          placeholder={fallbackName}
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        初始昵称默认取邮箱前缀；保存后首页会显示“你好，{name.trim() || fallbackName}
        ”。
      </p>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="h-10 rounded-2xl bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[0_10px_24px_rgba(124,92,255,0.2)] disabled:opacity-60"
        >
          {saving ? "保存中…" : "保存昵称"}
        </button>
        {message ? <span className="text-xs text-success">{message}</span> : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
