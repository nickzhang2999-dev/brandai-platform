import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { getMaskedAiSettings } from "@/lib/settings";
import { AiSettingsForm } from "./AiSettingsForm";

/**
 * Platform AI provider settings (admin only). The key is a platform secret, so
 * this page is gated to the platform admin — non-admins are bounced to
 * /workspaces (no leak that the page exists beyond the redirect).
 */
export default async function AdminAiSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/workspaces");
  }

  const initial = await getMaskedAiSettings();

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-serif text-2xl text-foreground">AI Provider 设置</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        平台级密钥,保存后即时生效、无需重新部署。留空的字段回退到环境变量。
        密钥加密存库,页面只显示掩码。
      </p>
      <AiSettingsForm initial={initial} />
    </div>
  );
}
