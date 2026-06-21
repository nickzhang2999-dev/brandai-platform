import { prisma } from "@brandai/db";
import { canReleaseVersion } from "@brandai/contracts";
import { ApiException, handleError, requireUser } from "@/lib/api";
import { getWorkspaceRole, requireOwnedWorkspace } from "@/lib/workspace";
import { getVersion } from "@/lib/generations";

/**
 * M6 · 单图下载 — proxy/stream the version's stored imageUrl so the browser
 * gets a clean attachment download without exposing the storage origin or
 * tripping CORS. Ownership is enforced via the owning Generation/workspace.
 * Works with zero AI keys (mock provider returns a public placehold.co url).
 */
export async function GET(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ wsId: string; genId: string; versionId: string }>;
  },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, versionId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const role = await getWorkspaceRole(wsId, user.id);

    const gen = await prisma.generation.findUnique({
      where: { id: genId },
    });
    if (!gen || gen.workspaceId !== wsId) {
      throw new ApiException(404, "Generation not found");
    }
    const version = await getVersion(versionId);
    if (!version || version.generationId !== genId) {
      throw new ApiException(404, "Version not found in this generation");
    }

    // K2 — separation of duties: a non-owner collaborator may only download a
    // RELEASED (final/approved) version, not an unapproved draft. The owner
    // downloads anything (phase-1 closed loop unchanged). 403 rather than 404
    // here: the version exists and belongs to the workspace, the caller just
    // lacks the release privilege for an unapproved draft.
    if (!canReleaseVersion(role, version)) {
      throw new ApiException(403, "该版本未审批通过,协作者暂不能下载");
    }

    const upstream = await fetch(version.imageUrl);
    if (!upstream.ok || !upstream.body) {
      throw new ApiException(502, "Failed to fetch source image");
    }
    const contentType =
      upstream.headers.get("content-type") ?? "image/png";
    const ext = contentType.includes("jpeg")
      ? "jpg"
      : contentType.includes("webp")
        ? "webp"
        : "png";
    const fileName = `${gen.id}-v${version.index}.${ext}`;

    return new Response(upstream.body, {
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
