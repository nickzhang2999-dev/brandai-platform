import { Prisma, prisma } from "@brandai/db";
import { WatermarkPresetInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "VIEWER");

    const rows = await prisma.watermarkPreset.findMany({
      where: { workspaceId: wsId },
      orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    });
    return ok(rows.map(serializePreset));
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

    const input = parse(WatermarkPresetInput, await req.json());
    const created = await prisma.$transaction(async (tx) => {
      if (input.isActive) {
        await tx.watermarkPreset.updateMany({
          where: { workspaceId: wsId, isActive: true },
          data: { isActive: false },
        });
      }
      return tx.watermarkPreset.create({
        data: {
          workspaceId: wsId,
          name: input.name,
          isActive: input.isActive,
          config: input.config as Prisma.InputJsonValue,
        },
      });
    });
    return ok(serializePreset(created), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
