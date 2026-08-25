import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { DecomposeResponse } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { recordUsage } from "@/lib/usage";
import { uploadDataUrlImage } from "@/lib/s3";
import { safeFetch } from "@/lib/ssrf";
import { analyzeLayerImage } from "@/lib/layers";
import {
  markRunning,
  setProgress,
  markSucceeded,
  markFailed,
} from "@/lib/async-tasks";

/**
 * 图层分解 worker —— 迁移自 prd_agent 视觉创作的 AI 分层。
 *
 * 为什么必须是 worker 而不是 HTTP handler:2026-08-25 打真上游实测,请求 4 层
 * 墙钟 41.8 秒(纯推理 14.0 秒),第一次调用就打穿 30 秒边缘网关上限。同步这条路
 * 怎么优化都拿不到结果——prd_agent 当年也是被 504 逼着改成任务制的。
 *
 * 产物形状(方案 A):一次分解产出 N 个 GenerationVersion 子版本,父版本 = 被拆
 * 的那一版。导出、终稿、素材库回流、配额、审批因此全部沿用现成链路。
 */
export interface DecomposeJobData {
  workspaceId: string;
  generationId: string;
  /** 被拆的那一版。 */
  sourceVersionId: string;
  /** 路由预先生成并已返回给客户端,客户端拿它直接订阅图层组。 */
  layerSetId: string;
  layerCount: number;
  intent?: string;
  taskId?: string;
}

export interface DecomposeJobResult {
  generationId: string;
  sourceVersionId: string;
  layerSetId: string;
  versionIds: string[];
}

/**
 * 取回一张图层的字节。
 *
 * 上游(fal)返回的是**临时** URL,过期就取不到了,所以必须当场下载并转存到我们
 * 自己的存储;顺带这份字节正好用来算实墨包围盒,不必为分析再拉一次。
 */
async function fetchLayerBytes(url: string): Promise<{ buf: Buffer; mime: string }> {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!match || !match[2]) throw new Error("unsupported inline layer payload");
    return {
      buf: Buffer.from(match[3] ?? "", "base64"),
      mime: match[1] || "image/png",
    };
  }
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`layer fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, mime: res.headers.get("content-type") || "image/png" };
}

export async function runDecomposeJob(
  job: Job<DecomposeJobData>,
): Promise<DecomposeJobResult> {
  const {
    workspaceId,
    generationId,
    sourceVersionId,
    layerSetId,
    layerCount,
    intent,
    taskId,
  } = job.data;

  try {
    await job.updateProgress(5);
    await markRunning(taskId, 5);

    const source = await prisma.generationVersion.findUnique({
      where: { id: sourceVersionId },
    });
    if (!source || source.generationId !== generationId) {
      throw new Error(
        `Source version ${sourceVersionId} not found in generation ${generationId}`,
      );
    }

    const raw = await ai.decompose({
      imageUrl: source.imageUrl,
      layerCount,
      ...(intent ? { intent } : {}),
    });
    // 再过一次契约:AI 服务是独立进程,别信它的形状,信 schema。
    const result = DecomposeResponse.parse(raw);
    if (result.layers.length === 0) {
      throw new Error("layer provider returned no layers");
    }

    await job.updateProgress(30);
    await setProgress(taskId, 30);

    if (result.usage) {
      await recordUsage({
        workspaceId,
        kind: "DECOMPOSE",
        status: "SUCCEEDED",
        generationId,
        provider: result.usage.provider,
        ...(result.usage.model ? { model: result.usage.model } : {}),
        imageCount: result.usage.imageCount,
        ...(result.usage.latencyMs !== undefined
          ? { latencyMs: result.usage.latencyMs }
          : {}),
      });
    }

    const agg = await prisma.generationVersion.aggregate({
      where: { generationId },
      _max: { index: true },
    });
    let nextIndex = (agg._max.index ?? -1) + 1;

    const sourceParams =
      source.params && typeof source.params === "object"
        ? (source.params as Record<string, unknown>)
        : {};
    const decomposedAt = new Date().toISOString();
    const versionIds: string[] = [];

    // 先把每一层备好(拉字节 → 分析 → 上传),**一层都不落库**;最后一次性提交。
    //
    // 逐层 create 的话,这一组在库里会有一段"半成品可见期":用户在这中间刷新,
    // 历史会把不完整的一组播种到画布上,而完成后的那次 invalidate 只把剩下的几层
    // 当 `freshAll` 送进来——`planLayerSetRect` 看见原来那块地已被占,就把后半截
    // 摆到**第二块矩形**上。一组图层被劈成两半，还都在画布上。
    //
    // **不在中途 abort**:上游可能给出比请求更多的层,那些层已经付过费,提前收工
    // 就等于把它们丢掉(prd_agent 的收集侧就是收满即断流,多给的层永远到不了画布)。
    // 这里把 emit 出来的每一层都收下。
    const prepared: Prisma.GenerationVersionCreateInput[] = [];
    for (let i = 0; i < result.layers.length; i++) {
      const layer = result.layers[i]!;
      const { buf, mime } = await fetchLayerBytes(layer.imageUrl);
      const analysis = await analyzeLayerImage(buf);
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      const storedUrl = await uploadDataUrlImage(
        dataUrl,
        `generations/${workspaceId}/layers`,
      );

      prepared.push({
          generation: { connect: { id: generationId } },
          index: nextIndex++,
          imageUrl: storedUrl,
          width: analysis.width || layer.width,
          height: analysis.height || layer.height,
          parentVersionId: source.id,
          isFinal: false,
          params: {
            ...sourceParams,
            imageKind: "GENERATED",
            layerRole: "layer",
            layerSetId,
            layerIndex: i,
            // 显隐一律默认可见。细层(实墨覆盖率极低)只打标记不隐藏——真上游
            // 实测那组绿色角标覆盖率 0.12%,是真实设计元素;按覆盖率自动隐藏
            // 会让用户以为模型没拆出来。
            layerHidden: false,
            layerOpacity: 1,
            layerZ: i,
            ...(analysis.bounds ? { layerBounds: analysis.bounds } : {}),
            layerInkCoverage: analysis.inkCoverage,
            layerThin: analysis.thin,
            decompose: {
              sourceVersionId: source.id,
              requestedLayerCount: layerCount,
              ...(intent ? { intent } : {}),
              ...(result.seed !== undefined ? { seed: result.seed } : {}),
              ...(result.usage?.provider
                ? { provider: result.usage.provider }
                : {}),
              decomposedAt,
            },
          } as Prisma.InputJsonValue,
      });

      // 备料阶段占 30→95;真正落库在循环之后。
      const pct = 30 + Math.round(((i + 1) / result.layers.length) * 60);
      await job.updateProgress(pct);
      await setProgress(taskId, pct);
    }

    // 一次事务把整组提交:要么这一组完整出现,要么一层都不出现。半成品可见期
    // 归零,前面那条失败回滚也就只剩下"事务之外出岔子"这一道兜底。
    const createdRows = await prisma.$transaction(
      prepared.map((data) => prisma.generationVersion.create({ data })),
    );
    versionIds.push(...createdRows.map((r) => r.id));

    await job.updateProgress(100);
    await markSucceeded(taskId, {
      refId: layerSetId,
      refCount: versionIds.length,
    });
    return { generationId, sourceVersionId: source.id, layerSetId, versionIds };
  } catch (err) {
    // 兜底撤销。整组落库已经改成一次事务,正常情况下失败时库里本就没有半成品;
    // 但事务**之后**仍有可能出岔子(markSucceeded 失败、进程被杀),那时这一组已
    // 经可见却没被标成功。留着这一句,让"要么完整、要么没有"这条不变量在事务之
    // 外也成立。
    //
    // 删除条件与所有读路径同源(`params.layerSetId === layerSetId`),而 layerSetId
    // 是本次 job 现生成的 uuid,不会误伤别的组。撤销本身再失败也不能盖掉真正的
    // 失败原因——那才是用户要看的那一句。
    try {
      const removed = await prisma.generationVersion.deleteMany({
        where: {
          generationId,
          params: { path: ["layerSetId"], equals: layerSetId },
        },
      });
      if (removed.count > 0) {
        console.warn(
          `[decompose] rolled back ${removed.count} partial layer(s) of set ${layerSetId}`,
        );
      }
    } catch (cleanupErr) {
      console.error("[decompose] rollback failed", cleanupErr);
    }
    await markFailed(taskId, String(err));
    throw err;
  }
}

export function createDecomposeWorker() {
  const worker = new Worker<DecomposeJobData, DecomposeJobResult>(
    "decompose",
    runDecomposeJob,
    {
      connection,
      prefix: queuePrefix,
      // 每个 job 自己就要把 N 张图拉回来做全幅 alpha 扫描,并发叠加会把 worker
      // 容器的内存打满。
      concurrency: 1,
    },
  );
  worker.on("failed", (job, err) => {
    console.error(`[decompose] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[decompose] job ${job.id} completed`);
  });
  return worker;
}
