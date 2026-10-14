import { ApiException, requireUser } from "./api";
/** Optional tab identity is only a consistency hint; cookie auth is authority. */
export async function requireStudioBrandMaterialUser(req: Request) {
  const user = await requireUser(), expected = req.headers.get("X-Novart-User");
  if (expected && expected !== user.id) throw new ApiException(409, "账号已切换，请重新打开素材库；原文件和任务仍保留。");
  return user;
}
