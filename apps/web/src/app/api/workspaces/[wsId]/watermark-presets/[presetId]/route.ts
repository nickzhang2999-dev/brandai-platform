import { Prisma, prisma } from "@brandai/db";
import { WatermarkPresetInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";

function serializePreset(row: {
  id: string;
  workspaceId: string;
  name: string;
  isActive: boolean;
  config: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    isActive: row.isActive,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadPreset(wsId: string, presetId: string, userId: string) {
  await requireWorkspaceRole(wsId, userId, "EDITOR");
  const preset = await prisma.watermarkPreset.findUnique({
    where: { id: presetId },
  });
  if (!preset || preset.workspaceId !== wsId) {
    throw new ApiException(404, "Watermark preset not found");
  }
  return preset;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; presetId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, presetId } = await params;
    await loadPreset(wsId, presetId, user.id);
    const input = parse(WatermarkPresetInput.partial(), await req.json());

    const updated = await prisma.$transaction(async (tx) => {
      if (input.isActive === true) {
        await tx.watermarkPreset.updateMany({
          where: { workspaceId: wsId, isActive: true, NOT: { id: presetId } },
          data: { isActive: false },
        });
      }
      return tx.watermarkPreset.update({
        where: { id: presetId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isActive !== undefined
            ? { isActive: input.isActive }
            : {}),
          ...(input.config !== undefined
            ? { config: input.config as Prisma.InputJsonValue }
            : {}),
        },
      });
    });
    return ok(serializePreset(updated));
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; presetId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, presetId } = await params;
    await loadPreset(wsId, presetId, user.id);
    await prisma.watermarkPreset.delete({ where: { id: presetId } });
    return ok({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
