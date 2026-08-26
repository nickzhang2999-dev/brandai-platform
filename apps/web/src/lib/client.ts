"use client";

/**
 * 带 HTTP 状态码的请求错误。
 *
 * 有些调用方要区分「服务端明确说这东西不存在(404)」和「这次没问到(网络断了/
 * 502/超时)」——两者的正确反应相反:前者该清理本地线索,后者必须原样留着重试。
 * 只给一句 message 的话,调用方只能把所有失败当同一种,于是一次抖动就会把
 * 「还在跑的那一单」的线索删掉。
 */
export class ApiFetchError extends Error {
  /** 0 表示请求根本没发出去/没拿到响应(网络层失败)。 */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
  }
}

/** Tiny typed fetch wrapper for client components (TanStack Query). */
export async function apiFetch<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiFetchError(
      detail || `Request failed (${res.status})`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/**
 * M-A · 资产公网代理 — build the same-origin proxy URL for an asset's bytes.
 * The stored `Asset.url` points at the internal storage origin (unreachable
 * from a public browser); routing thumbnails through the BFF makes them load
 * over the canonical domain. Set NEXT_PUBLIC_ASSET_PROXY=0 to fall back to the
 * raw stored URL. DoD D1.
 */
export function assetThumbUrl(
  wsId: string,
  assetId: string,
  fallbackUrl: string,
): string {
  if (process.env.NEXT_PUBLIC_ASSET_PROXY === "0") return fallbackUrl;
  return `/api/workspaces/${wsId}/assets/${assetId}/raw`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  LOGO: "Logo",
  PRODUCT: "产品图",
  PACKAGING: "包装",
  KV: "主视觉 KV",
  ECOM: "电商图",
  SOCIAL: "社媒图",
  VI_DOC: "VI 手册",
  OTHER: "其他",
};

export const CATEGORY_ORDER = [
  "LOGO",
  "PRODUCT",
  "PACKAGING",
  "KV",
  "ECOM",
  "SOCIAL",
  "VI_DOC",
  "OTHER",
] as const;
