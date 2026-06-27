"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
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
  const router = useRouter();
  const [brands, setBrands] = useState<BrandWorkspace[]>([]);

  const refreshBrands = useCallback(async () => {
    const loadedBrands = await apiFetch<BrandWorkspace[]>("/api/workspaces");
    setBrands(loadedBrands);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<BrandWorkspace[]>("/api/workspaces")
      .then((loadedBrands) => {
        if (!cancelled) setBrands(loadedBrands);
      })
      .catch(() => {
        // Keep the server-resolved workspace usable when the list is unavailable.
        if (!cancelled) setBrands([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 当前品牌以服务端解析出的 cookie 为准。切换品牌时只写 cookie 并刷新，
  // 防止客户端本地状态把 UI 固定到一个服务端已拒绝访问的 workspace。
  const switchBrand = useCallback(
    (workspaceId: string) => {
      document.cookie = `${ACTIVE_BRAND_COOKIE}=${encodeURIComponent(
        workspaceId,
      )}; path=/; max-age=${ACTIVE_BRAND_COOKIE_MAX_AGE}; samesite=lax`;
      router.refresh();
    },
    [router],
  );

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

  const activeBase = brands.find((brand) => brand.id === value.wsId);
  const context = useMemo<BrandCtx>(
    () => ({
      ...value,
      wsId: value.wsId,
      brandName: activeBase?.name ?? value.brandName,
      brands,
      switchBrand,
      refreshBrands,
      createBrand,
      updateBrand,
    }),
    [
      activeBase,
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
