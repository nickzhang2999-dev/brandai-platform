import { prisma } from "@brandai/db";
import { requireUser, ApiException } from "@/lib/api";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { nativeResponse, nativeErrorResponse } from "@/lib/native-project-response";
export const dynamic = "force-dynamic";
async function handle(req: Request) {
  try {
    const session = await requireUser();
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin request rejected");
    const path = new URL(req.url).pathname;
    if (req.headers.has("X-Novart-User") && req.headers.get("X-Novart-User") !== session.id) throw new ApiException(409, "账号已切换，请重新打开工作台。");
    if (path === "/api/www/lovart/time/utc/timestamp") return nativeResponse({ timestamp: String(Date.now()) });
    if (path !== "/api/www/user/getUserInfo") throw new ApiException(503, "此账号服务尚未接入。");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.id }, select: { id: true, name: true, image: true } });
    return nativeResponse({ uuid: user.id, nickname: user.name ?? "", avatar: user.image ?? "", preference: { lovart_version: "1.0" } });
  } catch (error) { return nativeErrorResponse(error); }
}
export { handle as GET, handle as POST };
