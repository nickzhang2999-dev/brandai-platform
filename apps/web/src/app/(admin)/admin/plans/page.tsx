import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { listAdminPlans } from "@/lib/admin-plans";
import { PlansTable } from "./PlansTable";

/**
 * Platform subscription-plan management (admin only). Lists every SaaS tier with
 * its quota knobs (daily rate limit / period quota / max brand workspaces) and
 * lets an operator edit them inline. Editing STARTER — the tier every user
 * without an active subscription resolves to — changes the default quota for all
 * designers at once. Gated to the platform admin; non-admins bounce to /workspaces.
 */
export default async function AdminPlansPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/workspaces");
  }

  const plans = await listAdminPlans();

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
        ADMIN · 订阅额度
      </div>
      <h1 className="font-serif text-3xl text-foreground">套餐额度</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        每个订阅档的生成额度与品牌数上限。改动即时生效,并作用于该档下所有账号。
        无有效订阅的账号默认走 STARTER,改 STARTER 即改所有设计师的默认额度。
      </p>
      <div className="mt-8">
        <PlansTable initial={plans} />
      </div>
    </div>
  );
}
