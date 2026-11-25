import { studioTimingEnabled } from "@/lib/studio-delivery-trace";
import { z } from "zod";
import { prisma } from "@brandai/db";
import { ApiException, handleError } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";

const common = z.object({
  requestId: z.string().regex(/^sgr_[a-f0-9]{32}$/),
  clickAt: z.number().int().positive().safe(),
});
const duration = z.number().int().min(0).max(3600000);
const observation = z.discriminatedUnion("stage", [
  common.extend({ stage: z.literal("click_linked") }).strict(),
  common
    .extend({
      stage: z.literal("canvas_visible"),
      assetId: z.string().regex(/^[\w-]{1,128}$/),
      durationMs: duration,
      clickToReadableMs: duration.optional(),
    })
    .strict(),
]);

export async function POST(req: Request) {
  if (!studioTimingEnabled())
    return new Response(null, { status: 204 });
  try {
    if (!isWorkbenchSameOrigin(req))
      throw new ApiException(403, "Cross-origin observation rejected");
    const { workspaceId, user } = await studioSession(req);
    const parsed = observation.safeParse(await readWorkbenchJson(req, 1024));
    if (!parsed.success)
      throw new ApiException(400, "Invalid delivery observation");
    const event = parsed.data;
    const owner = { requestId: event.requestId, workspaceId, userId: user.id };
    const found =
      event.stage === "canvas_visible"
        ? await prisma.studioGeneratedMaterial.findFirst({
            where: { ...owner, assetId: event.assetId, status: "SUCCEEDED" },
            select: { outputId: true },
          })
        : await prisma.studioGenerationRequest.findFirst({
            where: { id: event.requestId, workspaceId, userId: user.id },
            select: { id: true },
          });
    if (!found) throw new ApiException(404, "Observation target unavailable");
    console.info(
      "[studio-delivery]",
      JSON.stringify({ ...event, source: "browser", receivedAt: Date.now() }),
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return handleError(error);
  }
}
