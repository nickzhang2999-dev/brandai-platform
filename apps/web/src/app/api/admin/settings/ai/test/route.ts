import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { ai } from "@/lib/ai";
import { getEffectiveStorage } from "@/lib/settings";
import { nodeStreamToBuffer } from "@/lib/image-preview";

interface CheckResult {
  ok: boolean;
  detail: string;
  /** 什么都没探测过——既不是绿也不是红。三态的第三态,见 contracts 的 `DiagItem`。 */
  unverified?: boolean;
}

/**
 * Admin-only "测试连接 / Test connection" self-check. Validates the three
 * providers in seconds and reports the REAL per-item error, so an operator
 * doesn't discover a bad key (401) or a wrong S3 access key only after a slow
 * full image generation.
 *
 *  - image + vlm: the AI service probes each provider's `/models` (auth +
 *    reachability) via `ai.diag()`, which forwards the admin-configured keys.
 *  - storage: a bounded PutObject + GetObject byte comparison + DeleteObject
 *    round-trip. Cleanup has its own deadline, including an uncertain PUT.
 *    Provider error messages can contain credentials or private endpoints;
 *    return only known error categories and numeric HTTP status.
 */
function storageFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const labels: Record<string, string> = {
    AbortError: "请求超时或已取消",
    TimeoutError: "请求超时",
    AccessDenied: "存储权限不足",
    InvalidAccessKeyId: "存储访问凭据无效",
    SignatureDoesNotMatch: "存储签名校验失败",
    NoSuchBucket: "存储桶不存在",
    NoSuchKey: "测试对象未找到",
    ServiceUnavailable: "存储服务暂不可用",
  };
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)
    ?.$metadata?.httpStatusCode;
  const http = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? ` (HTTP ${status})` : "";
  const label = Object.prototype.hasOwnProperty.call(labels, name) ? labels[name] : "存储请求失败";
  return `${label}${http}`;
}

async function checkStorage(): Promise<CheckResult> {
  const cfg = await getEffectiveStorage();
  if (!cfg.configured) {
    return { ok: false, unverified: true, detail: "尚未配置对象存储，素材持久化未验证" };
  }
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    maxAttempts: 1,
  });
  const key = `__ov_diag/${randomUUID()}.txt`;
  const payload = Buffer.from(`novart-storage-check:${randomUUID()}`);
  const signal = AbortSignal.timeout(8_000);
  let versionId: string | undefined;
  let step = "写入";
  let failure = "";
  let cleanupFailure = "";
  try {
    const written = await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: payload,
        ContentType: "text/plain",
      }),
      { abortSignal: signal },
    );
    versionId = written.VersionId;
    step = "读取";
    const received = await client.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: key, VersionId: versionId }),
      { abortSignal: signal },
    );
    if (!received.Body) {
      failure = "存储读取失败：没有返回测试对象内容";
    } else {
      const bytes = await nodeStreamToBuffer(received.Body as Readable, payload.byteLength, signal);
      if (!bytes.equals(payload)) failure = "存储读取失败：测试对象内容与写入内容不一致";
    }
  } catch (err) {
    failure = `存储${step}失败：${storageFailure(err)}`;
  } finally {
    try {
      // A timed-out PUT may already have reached the store. Always attempt
      // cleanup, with a fresh signal rather than the expired read/write one.
      // Versioned buckets must delete the exact acknowledged version.
      await client.send(
        new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key, VersionId: versionId }),
        { abortSignal: AbortSignal.timeout(4_000) },
      );
    } catch (err) {
      cleanupFailure = `测试对象清理失败：${storageFailure(err)}；请检查 __ov_diag/ 下的遗留对象`;
    } finally {
      client.destroy();
    }
  }
  if (failure || cleanupFailure) return { ok: false, detail: [failure, cleanupFailure].filter(Boolean).join("；") };
  return { ok: true, detail: "存储写入、读取内容校验及测试对象清理均通过" };
}

export async function POST() {
  try {
    await requireAdmin();
    const [providers, storage] = await Promise.all([
      ai.diag(),
      checkStorage(),
    ]);
    return ok({
      image: providers.image,
      vlm: providers.vlm,
      // 分层上游也要能当场自测:管理员刚在上面存了 fal 密钥,却只能测出图/视觉,
      // 那这一栏就是个存进去看不见回音的黑箱。
      layer: providers.layer,
      storage,
    });
  } catch (err) {
    return handleError(err);
  }
}
