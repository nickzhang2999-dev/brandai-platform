import { prisma, Prisma } from "@brandai/db";
import { createHash } from "node:crypto";
import { CreateWorkspaceInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { assertCanCreateWorkspace } from "@/lib/quota";
import { ACTIVE_BRAND_COOKIE, ACTIVE_BRAND_COOKIE_MAX_AGE } from "@/lib/brand-cookie";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";

export async function GET() {
  try {
    const user = await requireUser();
    // G6 — list workspaces the user OWNS or is a MEMBER of (collaboration).
    const memberships = await prisma.membership.findMany({
      where: { userId: user.id },
      select: { workspaceId: true },
    });
    const memberWsIds = memberships.map((m) => m.workspaceId);
    const workspaces = await prisma.brandWorkspace.findMany({
      where: {
        OR: [{ ownerId: user.id }, { id: { in: memberWsIds } }],
      },
      orderBy: { createdAt: "desc" },
    });
    // Lovart-style kit rail: the card cover is not an independently managed
    // field. It always mirrors the first (newest, matching the kit page order)
    // Logo rule image. Keep the stored cover only as a legacy fallback.
    const logoRules = workspaces.length
      ? await prisma.brandRule.findMany({
          where: {
            workspaceId: { in: workspaces.map((workspace) => workspace.id) },
            type: "logo",
          },
          orderBy: { createdAt: "desc" },
          select: { workspaceId: true, evidence: true },
        })
      : [];
    const logoAssetByWorkspace = new Map<string, string>();
    for (const rule of logoRules) {
      if (logoAssetByWorkspace.has(rule.workspaceId)) continue;
      const evidence = Array.isArray(rule.evidence) ? rule.evidence : [];
      const assetId = evidence.find(
        (item): item is { assetId: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { assetId?: unknown }).assetId === "string",
      )?.assetId;
      if (assetId) logoAssetByWorkspace.set(rule.workspaceId, assetId);
    }

    return ok(
      workspaces.map((workspace) => {
        const logoAssetId = logoAssetByWorkspace.get(workspace.id);
        return {
          ...workspace,
          coverImage: logoAssetId
            ? `/api/workspaces/${workspace.id}/assets/${logoAssetId}/raw`
            : workspace.coverImage,
        };
      }),
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser && expectedUser !== user.id) throw new ApiException(409, "账号已切换，请重新打开工作台后创建品牌。");
    const mutationHeader = req.headers.get("X-Novart-Mutation");
    if (mutationHeader !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutationHeader)) {
      throw new ApiException(400, "品牌创建请求标识无效，请重新打开创建窗口。");
    }
    const mutationId = mutationHeader?.toLowerCase();
    const input = parse(CreateWorkspaceInput, await readWorkbenchJson(req, 4096));
    // Canonicalize the form value before the same wire contract checks it again.
    // Whitespace alone must not create an invisible option in the brand switcher.
    const normalized = parse(CreateWorkspaceInput, { ...input, name: input.name.trim() });
    const inputDigest = createHash("sha256").update(JSON.stringify({
      name: normalized.name, industry: normalized.industry ?? null, websiteUrl: normalized.websiteUrl ?? null,
    })).digest("hex");
    // K1 — enforce the plan's maxWorkspaces (tenant cap). Unlimited (-1, the
    // default/owner/admin plan) is a no-op, so phase-1 single-brand creation is
    // untouched; only a finite plan that's already at its cap throws 402.
    const workspace = await prisma.$transaction(async tx => {
      // All brand creations for one owner check their plan after obtaining the
      // same row lock. Concurrent submissions cannot both spend the last slot.
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${user.id} AND "isActive" = true FOR UPDATE`;
      if (!users[0]) throw new ApiException(403, "账号已被停用");
      if (mutationId) {
        const receipt = await tx.studioBrandCreation.findUnique({
          where: { userId_mutationId: { userId: user.id, mutationId } }, include: { workspace: true },
        });
        if (receipt) {
          if (receipt.inputDigest !== inputDigest) throw new ApiException(409, "这次品牌创建请求已用于其他内容，请重新打开创建窗口。");
          if (!receipt.workspace) throw new ApiException(410, "这次创建的品牌已经删除，请重新创建品牌。");
          if (receipt.workspace.ownerId !== user.id) throw new ApiException(404, "Brand not found");
          return receipt.workspace;
        }
      }
      await assertCanCreateWorkspace(user.id, tx);
      const created = await tx.brandWorkspace.create({
        data: { ownerId: user.id, name: normalized.name, industry: normalized.industry, websiteUrl: normalized.websiteUrl },
      });
      // Membership and workspace commit together; a failed membership cannot
      // leave an orphaned brand that the UI reports as a failed creation.
      await tx.membership.create({
        data: { userId: user.id, workspaceId: created.id, role: "OWNER" },
      });
      if (mutationId) await tx.studioBrandCreation.create({
        data: { userId: user.id, mutationId, inputDigest, workspaceId: created.id },
      });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5000 });
    const response = ok(workspace, { status: 201 });
    response.cookies.set(ACTIVE_BRAND_COOKIE, workspace.id, {
      path: "/", maxAge: ACTIVE_BRAND_COOKIE_MAX_AGE, sameSite: "lax",
      secure: new URL(req.url).protocol === "https:",
    });
    return response;
  } catch (err) {
    return handleError(err);
  }
}
