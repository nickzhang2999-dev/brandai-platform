import { prisma } from "@brandai/db";
import { AssetCategory } from "@brandai/contracts";
import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { uploadBuffer } from "@/lib/s3";
import { requireWorkspaceRole } from "@/lib/workspace";

/**
 * Server-side brand-asset upload. The browser POSTs a `multipart/form-data` body
 * (file + category) here; the BFF streams the bytes to the admin-configured (R2)
 * object store and persists the Asset row with its public URL. This replaces the
 * old presign → browser-direct-PUT flow, which broke over HTTPS because the
 * presigned URL pointed at the internal, browser-unreachable MinIO origin.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const form = await req.formData();
    const file = form.get("file");
    const categoryRaw = form.get("category");

    if (!(file instanceof File)) {
      throw new ApiException(400, "Missing file");
    }
    const parsedCategory = AssetCategory.safeParse(categoryRaw);
    if (!parsedCategory.success) {
      throw new ApiException(400, "Invalid category");
    }
    const category = parsedCategory.data;

    const buf = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const { key, url } = await uploadBuffer(buf, mimeType, wsId);

    const asset = await prisma.asset.create({
      data: {
        workspaceId: wsId,
        category,
        fileName: file.name,
        storageKey: key,
        url,
        mimeType,
        sizeBytes: buf.length,
        source: "UPLOAD",
      },
    });
    return ok(asset, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
