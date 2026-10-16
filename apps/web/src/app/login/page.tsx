"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Button, CreamCard, Input, Label } from "@brandai/ui";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  function destination() {
    const value = new URLSearchParams(window.location.search).get("callbackUrl");
    if (!value) return "/studio";
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname === "/login") return "/studio";
      if (url.pathname === "/") url.pathname = "/studio";
      return url.pathname + url.search + url.hash;
    } catch { return "/studio"; }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((p) => setProviders(Object.keys(p ?? {})))
      .catch(() => setProviders([]));
    fetch("/api/auth/registration", { cache: "no-store", signal: controller.signal })
      .then(async response => response.ok ? await response.json() : null)
      .then(body => { if (!controller.signal.aborted) setRegistrationOpen(body?.registrationOpen === true); })
      .catch(() => { if (!controller.signal.aborted) setRegistrationOpen(false); });
    return () => controller.abort();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "register") {
        if (!registrationOpen) throw new Error("注册暂未开放，请联系管理员");
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? "注册失败");
        }
      }
      const r = await signIn("password", {
        email,
        password,
        redirect: false,
      });
      if (r?.error) throw new Error("邮箱或密码不正确");
      window.location.href = destination();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <CreamCard className="w-full max-w-[436px] rounded-[28px] p-6 sm:p-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/deepflare-logo.svg"
          alt="DeepFlare · 曜影深蓝"
          className="mx-auto h-16 w-full max-w-[252px] object-contain dark:hidden"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/deepflare-logo-dark.svg" alt="DeepFlare · 曜影深蓝" className="mx-auto hidden h-16 w-full max-w-[252px] object-contain dark:block" />
        <h1 className="mt-6 text-center text-[21px] font-semibold leading-snug text-foreground sm:text-[24px]">
          {mode === "login" ? "进入你的品牌视觉工作台" : "创建账号"}
        </h1>
        {mode === "register" && (
          <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
            用邮箱开始建立品牌视觉系统（密码至少 8 位）
          </p>
        )}

        {(providers.includes("github") || providers.includes("google")) && (
          <div className="mt-6 flex flex-col gap-2">
            {providers.includes("github") && (
              <Button
                variant="outline"
                className="h-12 w-full rounded-2xl"
                onClick={() => signIn("github", { callbackUrl: destination() })}
              >
                用 GitHub 继续
              </Button>
            )}
            {providers.includes("google") && (
              <Button
                variant="outline"
                className="h-12 w-full rounded-2xl"
                onClick={() => signIn("google", { callbackUrl: destination() })}
              >
                用 Google 继续
              </Button>
            )}
            <div className="my-2 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-foreground/10" />
              <span className="font-mono uppercase tracking-[0.2em]">或</span>
              <span className="h-px flex-1 bg-foreground/10" />
            </div>
          </div>
        )}

        <form className="mt-7 flex flex-col gap-5" onSubmit={submit} aria-busy={loading}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-email" className="text-sm font-medium">邮箱</Label>
            <Input
              id="login-email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              inputMode="email"
              autoComplete={mode === "login" ? "username" : "email"}
              spellCheck={false}
              placeholder="输入邮箱地址"
              className="h-12 rounded-2xl px-4 text-[15px]"
              disabled={loading}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-password" className="text-sm font-medium">密码</Label>
            <div className="relative">
              <Input
                id="login-password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPassword ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder={mode === "login" ? "输入密码" : "设置密码，至少 8 位"}
                className="h-12 rounded-2xl pl-4 pr-12 text-[15px]"
                disabled={loading}
                required
                minLength={8}
              />
              <button
                type="button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                aria-pressed={showPassword}
                aria-controls="login-password"
                disabled={loading}
                className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setShowPassword((value) => !value)}
              >
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {showPassword ? <path d="m3 3 18 18M10.6 5.1A11 11 0 0 1 12 5c6 0 10 7 10 7a19 19 0 0 1-3.2 3.7M6.2 6.2A20 20 0 0 0 2 12s4 7 10 7a11 11 0 0 0 5.8-1.8M10 10a3 3 0 0 0 4 4" /> : <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>}
                </svg>
              </button>
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={loading} className="h-12 w-full rounded-2xl text-sm font-semibold">
            {loading ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
          </Button>
        </form>

        {registrationOpen && <button
          type="button"
          disabled={loading}
          className="mx-auto mt-6 block text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
          onClick={() => {
            setError(null);
            setShowPassword(false);
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login" ? "没有账号?去注册" : "已有账号?去登录"}
        </button>}

        {providers.includes("credentials") && (
          <button
            type="button"
            className="mt-2 block text-xs text-muted-foreground underline"
            onClick={() =>
              signIn("credentials", {
                email: email || "demo@brandai.dev",
                callbackUrl: destination(),
              })
            }
          >
            演示登录(免密,仅 staging)
          </button>
        )}
      </CreamCard>
    </div>
  );
}
