import { prisma } from "@brandai/db";
import { z } from "zod";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { cookies } from "next/headers";
import { ApiException } from "@/lib/api";
import { deleteBrand } from "@/lib/brand-deletion";
import { ACTIVE_BRAND_COOKIE, ACTIVE_BRAND_COOKIE_MAX_AGE } from "@/lib/brand-cookie";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";

const KB_DISABLED_TAG = "__kb_disabled";

const UpdateWorkspaceInput = z.object({
  name: z.string().min(1).max(80).optional(),
  industry: z.string().max(80).optional(),
  disabled: z.boolean().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    const workspace = await requireOwnedWorkspace(wsId, user.id);
    const [assetCount, ruleCount, termCount, projectCount] = await Promise.all([
      prisma.asset.count({ where: { workspaceId: wsId } }),
      prisma.brandRule.count({ where: { workspaceId: wsId } }),
      prisma.complianceTerm.count({ where: { workspaceId: wsId } }),
      prisma.project.count({ where: { workspaceId: wsId } }),
    ]);
    return ok({
      workspace,
      stats: { assetCount, ruleCount, termCount, projectCount },
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser && expectedUser !== user.id) throw new ApiException(409, "登录账号已切换，请刷新后再删除品牌。");
    const preferred = (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value;
    const result = await deleteBrand(wsId, user.id, await readWorkbenchJson(req, 4096), preferred);
    const response = ok(result, { headers: { "Cache-Control": "private, no-store" } });
    response.cookies.set(ACTIVE_BRAND_COOKIE, result.nextWorkspaceId ?? "", {
      path: "/", sameSite: "lax", secure: new URL(req.url).protocol === "https:",
      maxAge: result.nextWorkspaceId ? ACTIVE_BRAND_COOKIE_MAX_AGE : 0,
    });
    return response;
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    const { workspace } = await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(UpdateWorkspaceInput, await req.json());
    const tags = new Set(workspace.tags ?? []);
    if (input.disabled === true) tags.add(KB_DISABLED_TAG);
    if (input.disabled === false) tags.delete(KB_DISABLED_TAG);

    const updated = await prisma.brandWorkspace.update({
      where: { id: wsId },
      data: {
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.industry != null ? { industry: input.industry || null } : {}),
        ...(input.disabled != null ? { tags: Array.from(tags) } : {}),
      },
    });
    return ok(updated);
  } catch (err) {
    return handleError(err);
  }
}
