"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Button, CreamCard, Input, Label } from "@brandai/ui";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((p) => setProviders(Object.keys(p ?? {})))
      .catch(() => setProviders([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "register") {
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
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <CreamCard className="w-full max-w-sm p-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/nova-art-lab-logo.png"
          alt="NOVA ART LAB"
          className="h-20 w-full object-contain"
        />
        <h1 className="mt-3 font-serif text-3xl leading-tight text-foreground">
          {mode === "login" ? "登录 BrandAI" : "创建账号"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {mode === "login"
            ? "进入你的品牌视觉工作台。"
            : "用邮箱开始建立品牌视觉系统(密码至少 8 位)。"}
        </p>

        {(providers.includes("github") || providers.includes("google")) && (
          <div className="mt-6 flex flex-col gap-2">
            {providers.includes("github") && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => signIn("github", { callbackUrl: "/" })}
              >
                用 GitHub 继续
              </Button>
            )}
            {providers.includes("google") && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => signIn("google", { callbackUrl: "/" })}
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

        <form className="mt-6 flex flex-col gap-3" onSubmit={submit}>
          <Label>邮箱</Label>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
          />
          <Label>密码</Label>
          <Input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            minLength={8}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={loading} className="mt-2 w-full">
            {loading ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
          </Button>
        </form>

        <button
          type="button"
          className="mt-4 text-sm text-muted-foreground underline"
          onClick={() => {
            setError(null);
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login" ? "没有账号?去注册" : "已有账号?去登录"}
        </button>

        {providers.includes("credentials") && (
          <button
            type="button"
            className="mt-2 block text-xs text-muted-foreground underline"
            onClick={() =>
              signIn("credentials", {
                email: email || "demo@brandai.dev",
                callbackUrl: "/",
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
