import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { ai } from "@/lib/ai";
import { getEffectiveStorage } from "@/lib/settings";

interface CheckResult {
  ok: boolean;
  detail: string;
}

/**
 * Admin-only "测试连接 / Test connection" self-check. Validates the three
 * providers in seconds and reports the REAL per-item error, so an operator
 * doesn't discover a bad key (401) or a wrong S3 access key only after a slow
 * full image generation.
 *
 *  - image + vlm: the AI service probes each provider's `/models` (auth +
 *    reachability) via `ai.diag()`, which forwards the admin-configured keys.
 *  - storage: a real PutObject + DeleteObject round-trip with the same S3 client
 *    the generate worker uses, so errors like "access key length 18" surface
 *    verbatim.
 */
async function checkStorage(): Promise<CheckResult> {
  const cfg = await getEffectiveStorage();
  if (!cfg.configured) {
    return { ok: true, detail: "未配置存储,生成图将内联为 data URL" };
  }
  try {
    const client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secretKey,
      },
    });
    const key = `__ov_diag/${randomUUID()}.txt`;
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: "ok",
        ContentType: "text/plain",
      }),
    );
    await client.send(
      new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
    );
    return { ok: true, detail: `存储读写正常 (${cfg.bucket})` };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
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
      storage,
    });
  } catch (err) {
    return handleError(err);
  }
}
