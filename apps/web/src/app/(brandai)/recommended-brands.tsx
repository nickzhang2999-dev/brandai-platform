"use client";

import { useQuery } from "@tanstack/react-query";
import type { BrandWorkspace } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import { gradientFor } from "./_ui";

/**
 * L2 / B5 / H14 — homepage "推荐品牌" masonry/waterfall. Renders REAL
 * BrandWorkspace rows from `GET /api/brands/recommended` (only brands the
 * current user owns or is a member of — phase-1 single-super-admin, no
 * cross-tenant leak). Verified brands float first. CSS columns give the
 * staggered waterfall; cards have intentionally varied heights via the
 * cover/description so it reads as a Masonry rather than a uniform grid.
 *
 * No mock rows: with no brands, an honest empty state is shown.
 */
export function RecommendedBrands() {
  const { data: brands = [], isLoading } = useQuery({
    queryKey: ["brandai-recommended-brands"],
    queryFn: () => apiFetch<BrandWorkspace[]>(`/api/brands/recommended`),
  });

  return (
    <section className="mt-12">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">推荐品牌</h2>
        <span className="text-xs text-muted-foreground">
          已认证与精选的品牌展示
        </span>
      </div>

      {isLoading ? (
        <div className="rounded-3xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : brands.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center">
          <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-xl text-primary">
            ✦
          </span>
          <p className="text-sm font-medium">暂无推荐品牌</p>
          <p className="mt-1 text-xs text-muted-foreground">
            完善并认证品牌资料后，会在这里以瀑布流展示。
          </p>
        </div>
      ) : (
        // CSS columns = Masonry waterfall. `break-inside-avoid` keeps each card
        // intact across the column flow.
        <div className="columns-1 gap-[18px] sm:columns-2 lg:columns-3 [&>*]:mb-[18px]">
          {brands.map((b) => (
            <BrandCard key={b.id} brand={b} />
          ))}
        </div>
      )}
    </section>
  );
}

/** H14 · 推荐品牌卡 — cover + name + (verified) + subtitle/slogan + tags. */
function BrandCard({ brand }: { brand: BrandWorkspace }) {
  // Stagger cover heights deterministically by id so the waterfall is uneven
  // (reads as Masonry, not a uniform grid).
  const heights = ["h-28", "h-36", "h-44"];
  let h = 0;
  for (let i = 0; i < brand.id.length; i++)
    h = (h * 31 + brand.id.charCodeAt(i)) >>> 0;
  const coverHeight = heights[h % heights.length]!;
  const tags = brand.tags ?? [];

  return (
    <div className="break-inside-avoid overflow-hidden rounded-3xl border border-border bg-card shadow-[0_8px_24px_rgba(30,30,60,0.06)] transition-all hover:-translate-y-0.5 hover:border-primary/30">
      {brand.coverImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brand.coverImage}
          alt={brand.name}
          className={`w-full ${coverHeight} object-cover`}
        />
      ) : (
        <div
          className={`w-full ${coverHeight}`}
          style={{ background: gradientFor(brand.id) }}
        />
      )}
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold">
            {brand.name}
          </span>
          {brand.isVerified ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
              ✓ 认证
            </span>
          ) : null}
        </div>
        {brand.subtitle ? (
          <p className="text-xs font-medium text-foreground/80">
            {brand.subtitle}
          </p>
        ) : null}
        {brand.slogan ? (
          <p className="text-xs italic text-muted-foreground">
            “{brand.slogan}”
          </p>
        ) : null}
        {brand.description ? (
          <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
            {brand.description}
          </p>
        ) : null}
        {tags.length ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
