import { cookies } from "next/headers";
import { SelectWorkbenchWorkspaceInput } from "@brandai/contracts";
import { ApiException, requireUser } from "./api";
import { ACTIVE_BRAND_COOKIE } from "./brand-cookie";
import { getWorkbenchSession } from "./workbench-session";

export async function studioSession(req: Request, needWorkspace = true) {
  const user = await requireUser();
  const expectedUser = req.headers.get("X-Novart-User");
  if (expectedUser && expectedUser !== user.id) throw new ApiException(409, "账号已切换，请刷新工作台后继续。当前修改仍保留。");
  const explicit = new URL(req.url).searchParams.get("workspaceId");
  if (explicit !== null) SelectWorkbenchWorkspaceInput.parse({ workspaceId: explicit });
  const preferred = explicit ?? (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value;
  // A previous account's preference cookie is not an explicit tab selection.
  // Only a pinned URL must fail instead of choosing the user's accessible brand.
  const session = await getWorkbenchSession(user, preferred, explicit !== null);
  if (needWorkspace && !session.activeWorkspaceId) throw new ApiException(409, "请先创建或选择品牌。");
  return { user, session, workspaceId: session.activeWorkspaceId! };
}
