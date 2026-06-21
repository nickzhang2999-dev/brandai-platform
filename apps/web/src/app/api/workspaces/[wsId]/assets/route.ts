import { prisma } from "@brandai/db";
import { AssetCategory, CreateAssetInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { getEffectiveStorage } from "@/lib/settings";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { serializeAsset } from "@/lib/assets";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    const url = new URL(req.url);
    const categoryParam = url.searchParams.get("category");
    const category =
      categoryParam && AssetCategory.safeParse(categoryParam).success
        ? (categoryParam as AssetCategory)
        : undefined;

    const assets = await prisma.asset.findMany({
      where: { workspaceId: wsId, ...(category ? { category } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return ok(assets.map(serializeAsset));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(CreateAssetInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    // 2026-05-28 — publicUrl is sourced from AppSetting (admin-configured
    // R2 / COS / etc.), NOT module-level S3_PUBLIC_URL env. The cds-compose
    // change in the same commit removed the S3_* env injection because the
    // platform's storage truth now lives in AppSetting. Falling back to env
    // here would produce broken http://localhost:9000/brandai/... URLs.
    const storage = await getEffectiveStorage();
    // Strip any trailing slash on the configured publicUrl before joining, so a
    // base like "https://cdn.example.com/" doesn't yield "…com//key". Mirrors
    // the normalization in lib/s3.ts (uploadDataUrlImage / uploadBuffer) so URLs
    // are consistent whether the asset came from this route or the worker.
    const publicBase = storage.publicUrl.replace(/\/+$/, "");
    const asset = await prisma.asset.create({
      data: {
        workspaceId: wsId,
        category: input.category,
        fileName: input.fileName,
        storageKey: input.storageKey,
        url: `${publicBase}/${input.storageKey}`,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        source: input.source,
      },
    });
    return ok(serializeAsset(asset), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
