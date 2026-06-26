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
  brands: BrandWorkspace[];
  switchBrand: (workspaceId: string) => void;
  refreshBrands: () => Promise<void>;
  createBrand: (input: {
    name: string;
    industry?: string;
  }) => Promise<BrandWorkspace>;
  updateBrand: (
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
  const [brands, setBrands] = useState<BrandWorkspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(value.wsId);

  const refreshBrands = useCallback(async () => {
    const loadedBrands = await apiFetch<BrandWorkspace[]>("/api/workspaces");
    setBrands(loadedBrands);
    const saved = window.localStorage.getItem("brandai-active-brand");
    setActiveWorkspaceId((current) => {
      if (saved && loadedBrands.some((brand) => brand.id === saved)) {
        return saved;
      }
      if (loadedBrands.some((brand) => brand.id === current)) return current;
      return loadedBrands[0]?.id ?? value.wsId;
    });
  }, [value.wsId]);

  useEffect(() => {
    let cancelled = false;
    refreshBrands().catch(() => {
      // Keep the server-resolved workspace usable when the list is unavailable.
      if (!cancelled) setBrands([]);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshBrands]);

  const switchBrand = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    window.localStorage.setItem("brandai-active-brand", workspaceId);
  }, []);

  const createBrand = useCallback(
    async (input: { name: string; industry?: string }) => {
      const created = await apiFetch<BrandWorkspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setBrands((currentBrands) => [created, ...currentBrands]);
      switchBrand(created.id);
      return created;
    },
    [switchBrand],
  );

  const updateBrand = useCallback(
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
      setBrands((currentBrands) =>
        currentBrands.map((brand) =>
          brand.id === updated.id ? updated : brand,
        ),
      );
      return updated;
    },
    [],
  );

  const activeBase =
    brands.find((brand) => brand.id === activeWorkspaceId) ??
    brands.find((brand) => brand.id === value.wsId);
  const context = useMemo<BrandCtx>(
    () => ({
      ...value,
      wsId: activeBase?.id ?? activeWorkspaceId,
      brandName: activeBase?.name ?? value.brandName,
      brands,
      switchBrand,
      refreshBrands,
      createBrand,
      updateBrand,
    }),
    [
      activeBase,
      activeWorkspaceId,
      brands,
      createBrand,
      refreshBrands,
      switchBrand,
      updateBrand,
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
