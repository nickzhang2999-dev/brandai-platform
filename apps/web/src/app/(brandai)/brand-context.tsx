"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { BrandWorkspace } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";

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
  refreshKnowledgeBases: () => Promise<void>;
  createKnowledgeBase: (input: {
    name: string;
    industry?: string;
  }) => Promise<BrandWorkspace>;
  updateKnowledgeBase: (
    workspaceId: string,
    patch: { name?: string; industry?: string; disabled?: boolean },
  ) => Promise<BrandWorkspace>;
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
  const [knowledgeBases, setKnowledgeBases] = useState<BrandWorkspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(value.wsId);

  const refreshKnowledgeBases = useCallback(async () => {
    const bases = await apiFetch<BrandWorkspace[]>("/api/workspaces");
    setKnowledgeBases(bases);
    const saved = window.localStorage.getItem("brandai-active-knowledge-base");
    setActiveWorkspaceId((current) => {
      if (saved && bases.some((base) => base.id === saved)) return saved;
      if (bases.some((base) => base.id === current)) return current;
      return bases[0]?.id ?? value.wsId;
    });
  }, [value.wsId]);

  useEffect(() => {
    let cancelled = false;
    refreshKnowledgeBases().catch(() => {
      // Keep the server-resolved workspace usable when the list is unavailable.
      if (!cancelled) setKnowledgeBases([]);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKnowledgeBases]);

  const switchKnowledgeBase = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    window.localStorage.setItem("brandai-active-knowledge-base", workspaceId);
  }, []);

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

  const updateKnowledgeBase = useCallback(
    async (
      workspaceId: string,
      patch: { name?: string; industry?: string; disabled?: boolean },
    ) => {
      const updated = await apiFetch<BrandWorkspace>(
        `/api/workspaces/${workspaceId}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      setKnowledgeBases((bases) =>
        bases.map((base) => (base.id === updated.id ? updated : base)),
      );
      return updated;
    },
    [],
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
      refreshKnowledgeBases,
      createKnowledgeBase,
      updateKnowledgeBase,
    }),
    [
      activeBase,
      activeWorkspaceId,
      createKnowledgeBase,
      knowledgeBases,
      refreshKnowledgeBases,
      switchKnowledgeBase,
      updateKnowledgeBase,
      value,
    ],
  );

  return <Ctx.Provider value={context}>{children}</Ctx.Provider>;
}

export function useBrand(): BrandCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBrand must be used inside BrandProvider");
  return v;
}
