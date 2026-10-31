import type { Prisma } from "@brandai/db";
import { ApiException } from "./api";

/** Acquire before project locks. The DB trigger also protects old factories,
 * but this order avoids a delete-brand / lock-project / insert-task deadlock. */
export async function lockTaskWorkspace(db: Pick<Prisma.TransactionClient, "$queryRaw">, workspaceId: string) {
  const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BrandWorkspace" WHERE "id" = ${workspaceId} FOR KEY SHARE`;
  if (!rows[0]) throw new ApiException(409, "品牌已删除，任务未提交。");
}
