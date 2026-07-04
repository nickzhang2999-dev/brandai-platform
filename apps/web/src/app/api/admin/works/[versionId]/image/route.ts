import { prisma } from "@brandai/db";
import { requireAdmin } from "@/lib/admin";
import { ApiException, handleError } from "@/lib/api";

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,([\s\S]*)$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    await requireAdmin();
    const { versionId } = await params;
    const row = await prisma.generationVersion.findUnique({
      where: { id: versionId },
      select: { imageUrl: true },
    });
    if (!row) throw new ApiException(404, "Generation version not found");

    const match = row.imageUrl.match(DATA_URL_RE);
    if (!match) {
      return Response.redirect(new URL(row.imageUrl, req.url), 302);
    }

    const contentType = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || "";
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");

    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
