import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { ActivityTable } from "./activity-table";

export const dynamic = "force-dynamic";

/**
 * §2.3 · 运行日志(admin only)。每一次 AI 调用都在 UsageLog 里有一行 —— 把它
 * 按时间倒序铺出来,头号信息是「耗时」(latencyMs) 和「出图?」
 * (imageCount > 0)。/admin/usage 是按天 × 模型聚合的成本看板,本页是原始
 * 逐条历史,看用的是不是慢、有没有回内容。
 *
 * 与 /admin/usage 的分工:聚合看走势 vs 原始看每一笔。
 */
export default async function AdminActivityPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/workspaces");
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        ADMIN · 运行日志
      </div>
      <h1 className="font-serif text-3xl text-foreground">运行日志</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        每次 AI 调用一行(生成 / 识别 / 解析说明书 / 编辑 / 合规预检)。重点列是
        「耗时」和「出图」—— 用来看请求是不是慢、有没有回内容。
        想看按天聚合的成本/失败率,看{" "}
        <a className="underline hover:text-foreground" href="/admin/usage">
          用量看板
        </a>
        。
      </p>
      <ActivityTable />
    </div>
  );
}
