import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import { DecomposeResponse } from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { recordUsage } from "@/lib/usage";
import { uploadDataUrlImage } from "@/lib/s3";
import { safeFetch } from "@/lib/ssrf";
import { analyzeLayerImage } from "@/lib/layers";
import { getProvidersHealth } from "@/lib/settings";
import {
  markRunning,
  setProgress,
  markSucceededOrThrow,
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

/**
 * §2.4 看门狗上界。
 *
 * 真上游实测最长 110 秒(1.5MB data-URL 入参那次),再加 N 层的下载与全幅 alpha
 * 扫描,6 分钟足够宽。取这个值还有一层考虑:客户端的中间态上界也是 6 分钟,两边
 * 对齐,不会出现"页面已经放弃、服务端还标着 RUNNING"的长期不一致。
 */
const TIMEOUT_MS = 6 * 60_000;

class DecomposeTimeoutError extends Error {
  constructor() {
    super(`图层分解超时（超过 ${Math.round(TIMEOUT_MS / 1000)} 秒）`);
    this.name = "DecomposeTimeoutError";
  }
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

  // §2.4:整条流程与 TIMEOUT_MS 赛跑,超时落进外层 catch → 任务标 FAILED。
  //
  // 这一条对分解尤其要紧:它是全仓**唯一** concurrency:1 的 worker(其余都是 2),
  // 卡死一个 job 不只是这一次拆解永远 RUNNING,而是把整条分解队列堵死——后面所有
  // 人的分解都排在它后面。
  //
  // Promise.race 只决定外层 await 看见谁,**不会取消**里面那条链(AI fetch 没有
  // AbortController)。所以让外层先写终态:`markFailed` 之后即使孤儿链稍后跑完,
  // 它落库的那一组也会被 catch 里的整组回滚清掉,不会留下"任务失败但图层却在"。
  let watchdog: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new DecomposeTimeoutError()), TIMEOUT_MS);
  });
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };

  /**
   * 终态只许写一次,谁先到算谁的(看门狗或内层的失败)。
   *
   * 超时之后那条孤儿链还在跑,它可能稍后把整组提交进库;`rollbackLayerSet` 用的
   * 是与所有读路径同源的条件,所以无论先后,最终留下的都是"任务 FAILED + 这一组
   * 不存在",不会出现"任务失败但图层却在画布上"。
   */
  let settled = false;
  const rollbackLayerSet = async () => {
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
      // 撤销失败不能盖掉真正的失败原因——那才是用户要看的那一句。
      console.error("[decompose] rollback failed", cleanupErr);
    }
  };
  const failOnce = async (err: unknown) => {
    if (settled) return;
    settled = true;
    await rollbackLayerSet();
    await markFailed(taskId, String(err));
  };

  try {
    const out = await Promise.race([runDecomposeInner(), timeout]);
    clearWatchdog();
    return out;
  } catch (err) {
    clearWatchdog();
    await failOnce(err);
    throw err;
  }

  async function runDecomposeInner(): Promise<DecomposeJobResult> {
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

    // **判据读的是真正跑了什么,不是配置说了什么。**
    //
    // 2026-08-27 线上事故的正面防线:那次后台自检是绿的(web 容器解析到 fal、
    // 探针 200),真正的分解却跑了 `MockLayerProvider`——0 秒返回 4 张深色占位图,
    // 任务标 SUCCEEDED。配置面的快检看不出这种事,因为配置面看起来完全正常;
    // 只有回执里的 `usage.provider` 说了实话。
    //
    // 部署方明确要 mock(env 写死 `LAYER_PROVIDER=mock`,本地开发的正常姿势)时放行。
    const ranMock = /^Mock/i.test(result.usage?.provider ?? "");
    if (ranMock && !(await getProvidersHealth()).layer.deliberateMock) {
      throw new Error(
        `图层分解跑的是占位实现(${result.usage?.provider}/${result.usage?.model}),不是真实上游。` +
          `多半是分层密钥没配到这个部署上——去「管理后台 → 设置 → AI 服务」确认「图层分解」那一栏,` +
          `或 curl /api/health 看 providers.layer 是否 configured。`,
      );
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

    // 已经被判超时就别再提交了。
    //
    // Promise.race 不会取消这条链:看门狗写完 FAILED 之后它还在跑,跑完照样能把
    // 整组插进去——那时用户看到的是"任务失败,可图层却在画布上"。实测过:不加这
    // 道闸,超时后该组仍残留 4 行。
    if (settled) {
      throw new Error(
        `已超时并判失败,丢弃迟到的 ${prepared.length} 层分解结果`,
      );
    }

    // 一次事务把整组提交:要么这一组完整出现,要么一层都不出现。半成品可见期
    // 归零,前面那条失败回滚也就只剩下"事务之外出岔子"这一道兜底。
    const createdRows = await prisma.$transaction(
      prepared.map((data) => prisma.generationVersion.create({ data })),
    );
    versionIds.push(...createdRows.map((r) => r.id));

    // 提交与那道闸之间还有一线窗口(毫秒级)。真在这一瞬翻成 settled,就把刚提交
    // 的这一组撤掉——"要么完整出现、要么不存在"这条不变量不留缝。
    if (settled) {
      await rollbackLayerSet();
      throw new Error("提交后判超时,已撤销本组图层");
    }
    // **在这里认领终态**,而不是等 markSucceeded 写完。
    //
    // 只判不认领的话还剩一条缝:看门狗恰在下面几个 await 之间烧掉,`failOnce` 会
    // 回滚整组并把任务标 FAILED,而这条链稍后照样把 SUCCEEDED 写上去——用户拿到
    // 一个成功的任务,`refId` 却指向一组已经被删掉的图层。判据与置位之间没有
    // await,单线程下插不进第二个写入者,这一句就是那把锁。
    settled = true;

    try {
      await job.updateProgress(100);
      // 走会抛的变体:终态写丢了必须让外层知道,否则任务永远停在 RUNNING,
      // 而图层已经提交、客户端还锁着等一个永远不来的完成通知。
      await markSucceededOrThrow(taskId, {
        refId: layerSetId,
        refCount: versionIds.length,
      });
    } catch (writeErr) {
      // 认领了却没写成(库挂了/进程被打断)。这时必须把认领让出去,否则下面的
      // `failOnce` 看见 settled 会直接返回,留下"整组可见 + 任务永远 RUNNING"。
      settled = false;
      throw writeErr;
    }
    return { generationId, sourceVersionId: source.id, layerSetId, versionIds };
  } catch (err) {
    // 兜底撤销。整组落库已经是一次事务,正常情况下失败时库里本就没有半成品;
    // 但事务**之后**仍可能出岔子(markSucceeded 失败、进程被杀),那时这一组已经
    // 可见却没被标成功。让"要么完整、要么没有"在事务之外也成立。
    await failOnce(err);
    throw err;
  }
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
