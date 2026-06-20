import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { getUsageSummary } from "@/lib/usage";

export const dynamic = "force-dynamic";

/**
 * T-conn-b · 用量 / 成本看板（admin only）。从 append-only UsageLog 按
 * UTC 日 × 模型聚合最近 30 天的调用数 / 失败数 / 出图数 / 成本。mock provider
 * 无价 → 成本为 0(看板照常显示调用与失败率)。
 */
export default async function AdminUsagePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/workspaces");
  }

  const { sinceDays, rows, totals } = await getUsageSummary(30);
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const failRate =
    totals.calls > 0 ? Math.round((totals.failures / totals.calls) * 100) : 0;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        ADMIN · 用量 / 成本
      </div>
      <h1 className="font-serif text-3xl text-foreground">用量看板</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        最近 {sinceDays} 天生成调用,按 UTC 日 × 模型聚合。成本为最佳估算(静态价目表);
        mock provider 无价计为 $0。
      </p>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "调用数", value: String(totals.calls) },
          { label: "失败率", value: `${failRate}%` },
          { label: "出图数", value: String(totals.imageCount) },
          { label: "成本估算", value: usd(totals.costUsd) },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border border-foreground/10 bg-card px-5 py-4"
          >
            <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {s.label}
            </div>
            <div className="mt-1 font-serif text-3xl text-foreground">
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 overflow-x-auto rounded-2xl border border-foreground/10 bg-card">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-foreground/10 text-left font-mono text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-3 font-medium">日期 (UTC)</th>
              <th className="px-5 py-3 font-medium">模型</th>
              <th className="px-5 py-3 font-medium">调用</th>
              <th className="px-5 py-3 font-medium">失败</th>
              <th className="px-5 py-3 font-medium">出图</th>
              <th className="px-5 py-3 text-right font-medium">成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.date}|${r.model}`}
                className="border-b border-foreground/5 last:border-0"
              >
                <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                  {r.date}
                </td>
                <td className="px-5 py-3 font-mono text-xs">{r.model}</td>
                <td className="px-5 py-3 tabular-nums">{r.calls}</td>
                <td className="px-5 py-3 tabular-nums">{r.failures}</td>
                <td className="px-5 py-3 tabular-nums">{r.imageCount}</td>
                <td className="px-5 py-3 text-right font-mono text-xs tabular-nums">
                  {usd(r.costUsd)}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-10 text-center text-sm text-muted-foreground"
                >
                  最近 {sinceDays} 天暂无生成调用
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
