"use client";

import { useState } from "react";
import { Button, CreamCard, Input, Label } from "@brandai/ui";

interface MaskedProvider {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  apiKeySet: boolean;
  envKeyPresent: boolean;
}
interface MaskedStorage {
  endpoint: string;
  region: string;
  bucket: string;
  publicUrl: string;
  forcePathStyle: boolean;
  secretKeyMasked: string;
  secretKeySet: boolean;
  envSecretPresent: boolean;
}
interface Masked {
  image: MaskedProvider;
  vlm: MaskedProvider;
  storage: MaskedStorage;
}

type Kind = "image" | "vlm";

const LABELS: Record<Kind, { title: string; hint: string }> = {
  image: {
    title: "出图 (Image)",
    hint: "铁律：图像模型固定 gpt-image-2。provider=openai,model=gpt-image-2（留空亦默认 gpt-image-2）。",
  },
  vlm: {
    title: "视觉理解 (VLM)",
    hint: "识别/合规/抓站。OpenRouter 填 baseUrl=https://openrouter.ai/api/v1、model=openai/gpt-4o。",
  },
};

export function AiSettingsForm({ initial }: { initial: Masked }) {
  // Prefill the provider so it's never left blank — a blank provider with a key
  // silently falls back to the mock provider (no real calls, no error).
  const [data, setData] = useState<Masked>({
    image: { ...initial.image, provider: initial.image.provider || "openai" },
    vlm: { ...initial.vlm, provider: initial.vlm.provider || "openai" },
    storage: { ...initial.storage },
  });
  // New keys typed by the admin; empty = leave the stored key unchanged.
  const [keys, setKeys] = useState<Record<Kind, string>>({ image: "", vlm: "" });
  // New storage secret key typed by the admin; empty = leave stored unchanged.
  const [storageSecret, setStorageSecret] = useState("");
  // Storage access key id. Not part of the masked view (write-only here); empty
  // string clears it on save (falls back to S3_ACCESS_KEY env).
  const [storageAccessKey, setStorageAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 测试连接 self-check state.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    image: { ok: boolean; detail: string };
    vlm: { ok: boolean; detail: string };
    storage: { ok: boolean; detail: string };
  } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  function field(kind: Kind, key: keyof MaskedProvider, value: string) {
    setData((d) => ({ ...d, [kind]: { ...d[kind], [key]: value } }));
  }

  function storageField<K extends keyof MaskedStorage>(
    key: K,
    value: MaskedStorage[K],
  ) {
    setData((d) => ({ ...d, storage: { ...d.storage, [key]: value } }));
  }

  async function save(opts?: {
    clearKey?: Kind;
    clearStorageSecret?: boolean;
    clearAccessKey?: boolean;
  }) {
    // Confirm before overwriting an already-stored API key — guards against a
    // browser/password-manager autofill silently replacing a working key. The
    // dedicated "清除已存密钥" path (which passes clearKey) is NOT gated.
    if (!opts?.clearKey) {
      for (const kind of ["image", "vlm"] as Kind[]) {
        if (keys[kind] && data[kind].apiKeySet) {
          const ok = window.confirm(
            `你正在替换已配置的「${kind === "image" ? "出图" : "视觉"}」密钥,确认覆盖?`,
          );
          if (!ok) return;
        }
      }
    }
    setSaving(true);
    setMsg(null);
    const body: {
      image: Record<string, string | null>;
      vlm: Record<string, string | null>;
      storage: Record<string, string | boolean | null>;
    } = {
      image: pack("image"),
      vlm: pack("vlm"),
      storage: packStorage(),
    };
    if (opts?.clearKey) body[opts.clearKey].apiKey = "";
    if (opts?.clearStorageSecret) body.storage.secretKey = "";
    if (opts?.clearAccessKey) body.storage.accessKey = "";
    try {
      const res = await fetch("/api/admin/settings/ai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e?.error ?? `保存失败 (${res.status})`);
      }
      const fresh = (await res.json()) as Masked;
      setData(fresh);
      setKeys({ image: "", vlm: "" });
      setStorageSecret("");
      setStorageAccessKey("");
      setMsg({ ok: true, text: "已保存,即时生效。" });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  function pack(kind: Kind): Record<string, string | null> {
    const p = data[kind];
    const out: Record<string, string | null> = {
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
    };
    // Only send a new key when the admin actually typed one (empty = unchanged).
    if (keys[kind]) out.apiKey = keys[kind];
    return out;
  }

  function packStorage(): Record<string, string | boolean | null> {
    const s = data.storage;
    const out: Record<string, string | boolean | null> = {
      endpoint: s.endpoint,
      region: s.region,
      bucket: s.bucket,
      publicUrl: s.publicUrl,
      forcePathStyle: s.forcePathStyle,
    };
    // Only send a new secret / access key when the admin actually typed one.
    if (storageSecret) out.secretKey = storageSecret;
    if (storageAccessKey) out.accessKey = storageAccessKey;
    return out;
  }

  async function runTest() {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/admin/settings/ai/test", {
        method: "POST",
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e?.error ?? `测试失败 (${res.status})`);
      }
      setTestResult(await res.json());
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "测试失败");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-5">
      {(["image", "vlm"] as Kind[]).map((kind) => {
        const p = data[kind];
        return (
          <CreamCard key={kind}>
            <h2 className="font-serif text-lg text-foreground">{LABELS[kind].title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{LABELS[kind].hint}</p>
            <div className="mt-4 grid gap-3">
              <div>
                <Label>Provider</Label>
                <Input
                  value={p.provider}
                  placeholder="openai"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  onChange={(e) => field(kind, "provider", e.target.value)}
                />
              </div>
              <div>
                <Label>Base URL(可选,网关时填)</Label>
                <Input
                  value={p.baseUrl}
                  placeholder="留空使用官方端点"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  onChange={(e) => field(kind, "baseUrl", e.target.value)}
                />
              </div>
              <div>
                <Label>Model</Label>
                <Input
                  value={p.model}
                  placeholder={kind === "image" ? "gpt-image-2" : "gpt-4o"}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  onChange={(e) => field(kind, "model", e.target.value)}
                />
              </div>
              <div>
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={keys[kind]}
                  // Stop the browser/password manager from auto-filling this
                  // (a saved login password silently overwriting the API key
                  // here is a real cause of upstream 401s).
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  placeholder={
                    p.apiKeySet
                      ? `已配置 ${p.apiKeyMasked} — 留空不修改`
                      : p.envKeyPresent
                        ? "环境变量已提供 — 留空沿用"
                        : "未配置 — 粘贴密钥"
                  }
                  onChange={(e) => setKeys((k) => ({ ...k, [kind]: e.target.value }))}
                />
                {p.apiKeySet && (
                  <button
                    type="button"
                    className="mt-1 text-xs text-muted-foreground underline"
                    onClick={() => save({ clearKey: kind })}
                    disabled={saving}
                  >
                    清除已存密钥
                  </button>
                )}
              </div>
            </div>
          </CreamCard>
        );
      })}

      <CreamCard>
        <h2 className="font-serif text-lg text-foreground">
          存储 (Storage / 生成图上传)
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          S3 兼容,腾讯 COS / Cloudflare R2 均可。留空时生成图以 data URL 内联(临时,占库);填好后生成图自动上传到你的桶,存公网 URL。
        </p>
        <div className="mt-4 grid gap-3">
          <div>
            <Label>Endpoint</Label>
            <Input
              value={data.storage.endpoint}
              placeholder="https://cos.ap-guangzhou.myqcloud.com"
              onChange={(e) => storageField("endpoint", e.target.value)}
            />
          </div>
          <div>
            <Label>Region</Label>
            <Input
              value={data.storage.region}
              placeholder="us-east-1"
              onChange={(e) => storageField("region", e.target.value)}
            />
          </div>
          <div>
            <Label>Bucket</Label>
            <Input
              value={data.storage.bucket}
              placeholder="brandai"
              onChange={(e) => storageField("bucket", e.target.value)}
            />
          </div>
          <div>
            <Label>Public URL(对外访问基址)</Label>
            <Input
              value={data.storage.publicUrl}
              placeholder="https://bucket.cos.ap-guangzhou.myqcloud.com"
              onChange={(e) => storageField("publicUrl", e.target.value)}
            />
          </div>
          <div>
            <Label>Force Path Style(true/false)</Label>
            <Input
              value={data.storage.forcePathStyle ? "true" : "false"}
              placeholder="R2 / MinIO 用 true;COS 等虚拟主机式用 false"
              onChange={(e) =>
                storageField("forcePathStyle", e.target.value === "true")
              }
            />
          </div>
          <div>
            <Label>Access Key ID</Label>
            <Input
              value={storageAccessKey}
              placeholder="留空不修改 / 回退环境变量"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              onChange={(e) => setStorageAccessKey(e.target.value)}
            />
            <button
              type="button"
              className="mt-1 text-xs text-muted-foreground underline"
              onClick={() => save({ clearAccessKey: true })}
              disabled={saving}
            >
              清除已存 Access Key(若被浏览器误填成邮箱,点这清掉)
            </button>
          </div>
          <div>
            <Label>Secret Key</Label>
            <Input
              type="password"
              value={storageSecret}
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              placeholder={
                data.storage.secretKeySet
                  ? `已配置 ${data.storage.secretKeyMasked} — 留空不修改`
                  : data.storage.envSecretPresent
                    ? "环境变量已提供 — 留空沿用"
                    : "未配置 — 粘贴密钥"
              }
              onChange={(e) => setStorageSecret(e.target.value)}
            />
            {data.storage.secretKeySet && (
              <button
                type="button"
                className="mt-1 text-xs text-muted-foreground underline"
                onClick={() => save({ clearStorageSecret: true })}
                disabled={saving}
              >
                清除已存密钥
              </button>
            )}
          </div>
        </div>
      </CreamCard>

      {msg && (
        <p className={`text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}

      {(testResult || testError) && (
        <CreamCard>
          <h2 className="font-serif text-lg text-foreground">连接自检结果</h2>
          {testError ? (
            <p className="mt-2 text-sm text-destructive">{testError}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {(
                [
                  ["出图", testResult!.image],
                  ["视觉", testResult!.vlm],
                  ["存储", testResult!.storage],
                ] as const
              ).map(([label, r]) => (
                <li key={label} className="text-sm">
                  <span
                    className={r.ok ? "text-success" : "text-destructive"}
                  >
                    {r.ok ? "✅" : "❌"} {label}
                  </span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground break-all">
                    {r.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CreamCard>
      )}

      <div className="flex gap-3">
        <Button onClick={() => save()} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </Button>
        <Button
          variant="outline"
          onClick={runTest}
          disabled={testing}
        >
          {testing ? "测试中…" : "测试连接"}
        </Button>
      </div>
    </div>
  );
}
