import { z } from "zod";
import { prisma } from "@brandai/db";
import { AssetCategory, IngestWebsiteInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { ai } from "@/lib/ai";
import { assertSafePublicUrl } from "@/lib/ssrf";
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
    // SSRF 防护:这个 URL 会被 AI 服务端 httpx.get 抓取,先拒内网/本地/元数据地址。
    // 注:AI 侧 follow_redirects=True,跨站重定向到内网的残留风险需在 apps/ai 侧
    // 进一步加固(httpx 传输层拦私网 IP)。
    await assertSafePublicUrl(input.url);
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

    // SSRF 防护:previewUrl/sourceUrl 会被存为 asset.url/storageKey,之后
    // /assets/[id]/raw 会服务端 fetch 它们。落库前先拒绝内网/本地/元数据地址。
    for (const img of input.images) {
      await assertSafePublicUrl(img.previewUrl);
      await assertSafePublicUrl(img.sourceUrl);
    }

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
