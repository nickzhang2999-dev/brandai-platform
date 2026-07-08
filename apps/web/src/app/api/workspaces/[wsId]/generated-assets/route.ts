import { prisma } from "@brandai/db";
import { CampaignStatus, GeneratedAsset, SceneType } from "@brandai/contracts";
import { handleError, ok, requireUser } from "@/lib/api";
import { serializeAsset } from "@/lib/assets";
import { requireOwnedWorkspace } from "@/lib/workspace";

const RANGE_DAYS = new Map([
  ["7", 7],
  ["30", 30],
  ["90", 90],
]);

const SORTS = new Set(["recent", "oldest", "project", "fileName"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    const projectId = url.searchParams.get("projectId")?.trim();
    const statusParam = url.searchParams.get("projectStatus");
    const projectStatus = CampaignStatus.safeParse(statusParam).success
      ? (statusParam as CampaignStatus)
      : undefined;
    const rangeParam = url.searchParams.get("range");
    const rangeDays = rangeParam ? RANGE_DAYS.get(rangeParam) : undefined;
    const sortParam = url.searchParams.get("sort") ?? "recent";
    const sort = SORTS.has(sortParam) ? sortParam : "recent";
    const since = rangeDays
      ? new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000)
      : undefined;

    const relationFilter =
      projectId || projectStatus
        ? {
            generationVersion: {
              is: {
                generation: {
                  is: {
                    ...(projectId ? { projectId } : {}),
                    ...(projectStatus
                      ? { project: { is: { status: projectStatus } } }
                      : {}),
                  },
                },
              },
            },
          }
        : {};

    const assets = await prisma.asset.findMany({
      where: {
        workspaceId: wsId,
        libraryKind: "GENERATED",
        ...(since ? { createdAt: { gte: since } } : {}),
        ...relationFilter,
        ...(q
          ? {
              OR: [
                { fileName: { contains: q } },
                { aiDescription: { contains: q } },
                {
                  generationVersion: {
                    is: {
                      generation: { is: { sellingPoint: { contains: q } } },
                    },
                  },
                },
                {
                  generationVersion: {
                    is: { generation: { is: { scene: { contains: q } } } },
                  },
                },
                {
                  generationVersion: {
                    is: {
                      generation: {
                        is: { project: { is: { name: { contains: q } } } },
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        generationVersion: {
          include: {
            generation: {
              include: { project: true },
            },
          },
        },
      },
      orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
      take: 300,
    });

    const rows = assets
      .map((asset) => {
        const generation = asset.generationVersion?.generation;
        const project = generation?.project;
        return GeneratedAsset.parse({
          ...serializeAsset(asset),
          ...(generation
            ? {
                generationId: generation.id,
                generationCreatedAt: generation.createdAt.toISOString(),
                sceneType: SceneType.parse(generation.sceneType),
              }
            : {}),
          ...(project
            ? {
                projectId: project.id,
                projectName: project.name,
                projectStatus: CampaignStatus.parse(project.status),
              }
            : {}),
        });
      })
      .sort((a, b) => {
        if (sort === "project") {
          return (a.projectName ?? "").localeCompare(b.projectName ?? "", "zh");
        }
        if (sort === "fileName") {
          return a.fileName.localeCompare(b.fileName, "zh");
        }
        return 0;
      });

    return ok(rows);
  } catch (err) {
    return handleError(err);
  }
}
