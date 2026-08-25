import { randomUUID } from "node:crypto";
import { prisma } from "@brandai/db";
import { DecomposeVersionInput } from "@brandai/contracts";
import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { decomposeQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import { isLayerVersion, isVectorImage } from "@/lib/layers";
import type { DecomposeJobData } from "@/lib/workers/decompose.worker";

/**
 * POST — 图层分解（AI 分层）:把这一版出图拆成 N 张可独立编辑的 RGBA 图层。
 *
 * 它是**动作**不是模型:入口只能是"选中一张图之后的操作",请求体里没有、也不该
 * 有模型 / 尺寸 / 张数——那些对分层毫无意义。层数是花钱的请求参数,所以只从
 * 请求体读,绝不从设备偏好继承(prd_agent 把它存在浏览器本地,共享设备上前一个
 * 人选的层数会被下一个账号原样继承,而快捷入口不显示层数,用户没机会发现)。
 *
 * handler 只做:鉴权 → 快检 → 建任务 → 入队 → 202(§2.1)。真上游实测 12–42 秒,
 * 在 handler 里 await 必然超时。
 */
export async function POST(
  req: Request,
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
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const generation = await prisma.generation.findUnique({
      where: { id: genId },
    });
    if (!generation || generation.workspaceId !== wsId) {
      throw new ApiException(404, "Generation not found");
    }
    const version = await prisma.generationVersion.findUnique({
      where: { id: versionId },
    });
    if (!version || version.generationId !== genId) {
      throw new ApiException(404, "Version not found in this generation");
    }
    // 拆一张图层本身没有意义:它已经是分解产物,再拆一次只会得到它自己。
    if (isLayerVersion(version.params)) {
      throw new ApiException(400, "该版本已经是图层，不能再次分解");
    }
    // 矢量占位图不是位图,分层上游读不了。不拦的话要等排队 → 调上游 → 22 秒后
    // 拿一句英文的 image_load_error,用户只看到任务 FAILED 而不知道为什么
    // (mock 出图给的就是 SVG 占位,所以这条在没配真出图上游的环境里必踩)。
    if (isVectorImage(version.imageUrl)) {
      throw new ApiException(
        400,
        "这张是矢量占位图(SVG)，分层上游只接受位图。先用真实出图上游出一张图再拆。",
      );
    }

    // 直接用 schema 自己的 parse:带 .default() 的 schema 输入/输出类型不同,
    // 走 parse(schema, data) 这个泛型 helper 会推到输入那一侧,layerCount 就成了
    // number | undefined,默认值等于白写。抛的仍是 ZodError,错误处理不变。
    const input = DecomposeVersionInput.parse(await req.json());

    // setId 在这里生成并立刻返回,客户端拿到就能订阅这一组——不必等 worker 落库
    // 才知道自己该看哪一组。
    const layerSetId = randomUUID();
    const task = await createTask({ workspaceId: wsId, kind: "DECOMPOSE" });
    const jobData: DecomposeJobData = {
      workspaceId: wsId,
      generationId: genId,
      sourceVersionId: versionId,
      layerSetId,
      layerCount: input.layerCount,
      ...(input.intent ? { intent: input.intent } : {}),
      taskId: task.id,
    };
    const job = await decomposeQueue.add("decompose", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    await prisma.asyncTask.update({
      where: { id: task.id },
      data: { jobId: job.id ?? null },
    });

    return ok(
      {
        layerSetId,
        taskId: task.id,
        jobId: job.id ?? null,
        requestedLayerCount: input.layerCount,
      },
      { status: 202 },
    );
  } catch (err) {
    return handleError(err);
  }
}
