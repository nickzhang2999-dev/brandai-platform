/**
 * Active-brand selection is **server-authoritative** (CLAUDE.md §0.3): the
 * chosen brand (= workspace = tenant) is persisted in this cookie so the
 * server `(brandai)/layout` resolves the same brand the client is showing.
 *
 * Why a cookie and not localStorage: localStorage is invisible to the server,
 * so a localStorage-only switch left the SSR guard / deep links / shared links
 * on the *default* brand while the client showed another — two sources of truth
 * for "current tenant" (V0.02 shipped exactly that; see docs/10 #5). A cookie
 * is sent on every request, so server and client agree on a refresh / hard load.
 *
 * The id is always re-validated against the user's memberships server-side
 * (`getOrCreateActiveBrand`) before it is honored — never trust the cookie's
 * workspace id without an ownership check (multi-tenant isolation §3.5).
 */
export const ACTIVE_BRAND_COOKIE = "brandai-active-brand";

/** One year, root path so the `(brandai)` server layout reads the same value. */
export const ACTIVE_BRAND_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
