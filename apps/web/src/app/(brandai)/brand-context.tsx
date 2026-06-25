"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BrandWorkspace } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import {
  ACTIVE_BRAND_COOKIE,
  ACTIVE_BRAND_COOKIE_MAX_AGE,
} from "@/lib/brand-cookie";

/**
 * 当前品牌（workspace）上下文。由 (brandai)/layout 服务端解析后注入，客户端
 * 页面用 useBrand() 拿到 wsId 去调 workspace 作用域的 BFF 接口。
 */
export interface BrandCtx {
  wsId: string;
  brandName: string;
  user: { name: string; email: string; initial: string };
  knowledgeBases: BrandWorkspace[];
  switchKnowledgeBase: (workspaceId: string) => void;
  createKnowledgeBase: (input: {
    name: string;
    industry?: string;
  }) => Promise<BrandWorkspace>;
}

const Ctx = createContext<BrandCtx | null>(null);
type InitialBrandCtx = Pick<BrandCtx, "wsId" | "brandName" | "user">;

export function BrandProvider({
  value,
  children,
}: {
  value: InitialBrandCtx;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [knowledgeBases, setKnowledgeBases] = useState<BrandWorkspace[]>([]);
  // Initial active id comes from the server (it resolved ACTIVE_BRAND_COOKIE and
  // re-validated membership), so the cookie — not client state — is the single
  // source of truth for "current tenant".
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(value.wsId);

  useEffect(() => {
    let cancelled = false;
    apiFetch<BrandWorkspace[]>("/api/workspaces")
      .then((bases) => {
        if (!cancelled) setKnowledgeBases(bases);
      })
      .catch(() => {
        // Keep the server-resolved workspace usable when the list is unavailable.
        if (!cancelled) setKnowledgeBases([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Server is authoritative: whenever the layout re-resolves the active brand
  // from ACTIVE_BRAND_COOKIE (an RSC refresh, another tab's switch, or a
  // cleared/expired cookie), adopt the new server value so the client never
  // stays pinned to a stale workspace from first mount (Bugbot: stale brand
  // after cookie change). The optimistic set in switchKnowledgeBase still gives
  // instant feedback before the refresh lands; this reconciles to the server.
  useEffect(() => {
    setActiveWorkspaceId(value.wsId);
  }, [value.wsId]);

  const switchKnowledgeBase = useCallback(
    (workspaceId: string) => {
      // Always (re)persist the cookie — even when the id is unchanged — so a
      // cookie that was cleared/expired while the SPA stayed open gets
      // re-established; otherwise a later hard reload would ignore the UI choice
      // and resolve the default brand server-side (Bugbot: same-brand skipped
      // the cookie write). The cookie is server-read + membership-validated.
      document.cookie = `${ACTIVE_BRAND_COOKIE}=${encodeURIComponent(
        workspaceId,
      )}; path=/; max-age=${ACTIVE_BRAND_COOKIE_MAX_AGE}; samesite=lax`;
      // Only the state flip + SSR re-render are redundant when nothing changed.
      if (workspaceId === activeWorkspaceId) return;
      setActiveWorkspaceId(workspaceId);
      router.refresh();
    },
    [activeWorkspaceId, router],
  );

  const createKnowledgeBase = useCallback(
    async (input: { name: string; industry?: string }) => {
      const created = await apiFetch<BrandWorkspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setKnowledgeBases((bases) => [created, ...bases]);
      switchKnowledgeBase(created.id);
      return created;
    },
    [switchKnowledgeBase],
  );

  const activeBase =
    knowledgeBases.find((base) => base.id === activeWorkspaceId) ??
    knowledgeBases.find((base) => base.id === value.wsId);
  const context = useMemo<BrandCtx>(
    () => ({
      ...value,
      wsId: activeBase?.id ?? activeWorkspaceId,
      brandName: activeBase?.name ?? value.brandName,
      knowledgeBases,
      switchKnowledgeBase,
      createKnowledgeBase,
    }),
    [activeBase, activeWorkspaceId, createKnowledgeBase, knowledgeBases, switchKnowledgeBase, value],
  );

  return <Ctx.Provider value={context}>{children}</Ctx.Provider>;
}

export function useBrand(): BrandCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBrand must be used inside BrandProvider");
  return v;
}
