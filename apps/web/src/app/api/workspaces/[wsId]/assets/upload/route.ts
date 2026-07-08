import { prisma } from "@brandai/db";
import { AssetCategory, AssetLibraryKind } from "@brandai/contracts";
import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { uploadBuffer } from "@/lib/s3";
import { requireWorkspaceRole } from "@/lib/workspace";
import { serializeAsset, decodeImageResolution } from "@/lib/assets";

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
    const libraryKindRaw = form.get("libraryKind");
    const folderRaw = form.get("folderId");

    if (!(file instanceof File)) {
      throw new ApiException(400, "Missing file");
    }
    const parsedCategory = AssetCategory.safeParse(categoryRaw);
    if (!parsedCategory.success) {
      throw new ApiException(400, "Invalid category");
    }
    const category = parsedCategory.data;
    const parsedLibraryKind = AssetLibraryKind.safeParse(libraryKindRaw);
    const libraryKind = parsedLibraryKind.success
      ? parsedLibraryKind.data
      : "MATERIAL";

    // H6 — optional folder selected in the upload dialog. Validate ownership so
    // a cross-workspace folder id can't be filed against (§3.5 isolation rule 2,
    // mirrors the PATCH route's folder check / IDOR guard).
    let folderId: string | null = null;
    if (typeof folderRaw === "string" && folderRaw.length > 0) {
      const folder = await prisma.assetFolder.findUnique({
        where: { id: folderRaw },
        select: { workspaceId: true },
      });
      if (!folder || folder.workspaceId !== wsId) {
        throw new ApiException(404, "Folder not found");
      }
      folderId = folderRaw;
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const { key, url } = await uploadBuffer(buf, mimeType, wsId);

    // P04-M12 — persist the pixel dimensions so the detail panel's 尺寸 row
    // renders. Zero-dependency probe (PNG IHDR / JPEG SOF); a miss leaves
    // resolution unset rather than failing the upload.
    const resolution = decodeImageResolution(buf);

    const asset = await prisma.asset.create({
      data: {
        workspaceId: wsId,
        category,
        libraryKind,
        fileName: file.name,
        storageKey: key,
        url,
        mimeType,
        sizeBytes: buf.length,
        source: "UPLOAD",
        ...(resolution ? { resolution } : {}),
        ...(folderId ? { folderId } : {}),
      },
    });
    return ok(serializeAsset(asset), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
