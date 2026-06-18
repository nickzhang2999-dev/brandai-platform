"use client";

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
    throw new Error(detail || `Request failed (${res.status})`);
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
