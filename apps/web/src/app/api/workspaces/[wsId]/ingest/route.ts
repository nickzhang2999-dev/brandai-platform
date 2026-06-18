import { z } from "zod";
import { prisma } from "@brandai/db";
import { AssetCategory, IngestWebsiteInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { ai } from "@/lib/ai";
import { requireWorkspaceRole } from "@/lib/workspace";

/**
 * POST .../ingest -> proxy to AI service, return candidate
 * images / copies / sellingPoints for the selectable grid.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(IngestWebsiteInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    const result = await ai.ingestWebsite({ url: input.url });
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}

const SaveImage = z.object({
  sourceUrl: z.string(),
  previewUrl: z.string(),
  guessedCategory: z.string().optional(),
});
const SaveIngestedInput = z.object({
  images: z.array(SaveImage).min(1),
  category: AssetCategory.optional(),
});

function toCategory(guessed?: string): AssetCategory {
  const parsed = AssetCategory.safeParse(
    (guessed ?? "").toUpperCase(),
  );
  return parsed.success ? parsed.data : "OTHER";
}

/**
 * PUT .../ingest -> persist selected candidate images as WEBSITE assets.
 * previewUrl is stored as the asset url (no re-upload to S3 in P0).
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(SaveIngestedInput, await req.json());

    const created = await prisma.$transaction(
      input.images.map((img) => {
        const fileName =
          img.sourceUrl.split("/").pop()?.split("?")[0] || "website-asset";
        return prisma.asset.create({
          data: {
            workspaceId: wsId,
            category: input.category ?? toCategory(img.guessedCategory),
            fileName,
            storageKey: img.sourceUrl,
            url: img.previewUrl,
            mimeType: "image/*",
            sizeBytes: 0,
            source: "WEBSITE",
          },
        });
      }),
    );
    return ok(created, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
