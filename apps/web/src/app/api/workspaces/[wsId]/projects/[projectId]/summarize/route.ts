import { prisma } from "@brandai/db";
import { handleError, ok, requireUser, ApiException } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { summarizeQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import type { SummarizeJobData } from "@/lib/workers/summarize.worker";

/**
 * C8 · Campaign AI 摘要自动生成 — start an async campaign summary (§2: never
 * await the VLM in the handler). Body: none. The worker calls AI /v1/summarize
 * (mode=campaign_summary) over the campaign context (name + description/brief +
 * confirmed brand rule summaries) and persists the result onto
 * Project.aiSummary. The client polls the task, then refetches the project.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId: wsId },
      select: { id: true, name: true, description: true },
    });
    if (!project) throw new ApiException(404, "Project not found");

    const ws = await prisma.brandWorkspace.findUnique({
      where: { id: wsId },
      select: { name: true },
    });
    // Confirmed brand rules ground the summary in the brand's real knowledge.
    const rules = await prisma.brandRule.findMany({
      where: { workspaceId: wsId, status: "CONFIRMED" },
      select: { summary: true },
      take: 20,
    });
    const ruleSummaries = rules.map((r) => r.summary).filter(Boolean);

    // The context the model condenses: campaign name + its brief/description.
    const text = [project.name, project.description ?? ""]
      .filter(Boolean)
      .join("\n");

    const task = await createTask({ workspaceId: wsId, kind: "SUMMARIZE" });
    const jobData: SummarizeJobData = {
      workspaceId: wsId,
      mode: "campaign_summary",
      text,
      projectId: project.id,
      context: {
        campaignName: project.name,
        ...(ws?.name ? { brandName: ws.name } : {}),
        ...(ruleSummaries.length ? { ruleSummaries } : {}),
      },
      taskId: task.id,
    };
    const job = await summarizeQueue.add("summarize", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    await prisma.asyncTask.update({
      where: { id: task.id },
      data: { jobId: job.id },
    });

    return ok(
      { jobId: job.id, taskId: task.id, status: "PENDING" as const },
      { status: 202 },
    );
  } catch (err) {
    return handleError(err);
  }
}
