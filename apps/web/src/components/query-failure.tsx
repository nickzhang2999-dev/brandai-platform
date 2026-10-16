"use client";

/** A failed read must never masquerade as an empty collection. */
export function QueryFailure({ label = "内容", retry, retrying = false }: {
  label?: string; retry: () => unknown; retrying?: boolean;
}) {
  return <div role="alert" className="rounded-3xl border border-border bg-card p-6 text-center">
    <p className="text-sm text-destructive">{label}加载失败，请稍后重试。</p>
    <button type="button" disabled={retrying} onClick={() => { void retry(); }}
      className="mt-3 rounded-full border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50">
      {retrying ? "正在重试…" : "重试"}
    </button>
  </div>;
}
