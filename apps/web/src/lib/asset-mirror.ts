import { prisma } from "@brandai/db";
import { getEffectiveStorage } from "@/lib/settings";

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * F18 · 出图回流素材库 — map a generation `SceneType` onto the closest asset
 * library `AssetCategory` so the mirrored asset lands under a sensible filter.
 */
export function assetCategoryForScene(
  sceneType?: string | null,
):
  | "ECOM"
  | "SOCIAL"
  | "KV"
  | "OTHER" {
  switch (sceneType) {
    case "ECOM_MAIN":
    case "SELLING_POINT":
      return "ECOM";
    case "SOCIAL_POSTER":
      return "SOCIAL";
    case "CAMPAIGN_KV":
    case "SCENE":
      return "KV";
    default:
      return "OTHER";
  }
}

/**
 * F18 · 出图回流素材库 — mirror a freshly-persisted `GenerationVersion` into a
 * real `Asset` row so generated images surface in the asset library (P04)
 * alongside uploads, and can be favorited / foldered / re-used as references.
 *
 * 设计约束（共享 CDS Postgres）：**不新增 `AssetSource` 枚举值** —— 给共享库的枚举
 * 加值会让不认识该值的其它分支 Prisma client 读 `Asset` 直接崩（与 `ProjectAsset.kind`
 * 用 String 而非 enum 同源的血泪规则）。改用**加性可空列 `generationVersionId`** 标识
 * AI 生成来源；`source` 仍存 `UPLOAD`（已知枚举），UI 凭 `generationVersionId` 显示
 * 「AI 生成」。
 *
 * **Best-effort**：任何失败只 `warn`、**绝不抛** —— 出图版本已落库，回流只是附加投影，
 * 不能反过来让出图 FAILED（§0.1：真图必须浮现）。`generationVersionId` 上的唯一约束让
 * 重复调用（worker 重试 / 回填脚本）天然幂等。
 */
export async function mirrorGenerationVersionToAsset(opts: {
  workspaceId: string;
  generationVersionId: string;
  /** 落库到 GenerationVersion 的最终 URL（配了存储时为公网 http(s) URL）。 */
  imageUrl: string;
  /** 上传前的原始 `data:` URL，仅用于估算 sizeBytes；缺省则 size=0。 */
  dataUrl?: string;
  width: number;
  height: number;
  sceneType?: string | null;
  /** 文件名标签（不含扩展名）；扩展名由 storageKey 推出后追加。 */
  fileLabel: string;
  aiDescription?: string;
}): Promise<void> {
  try {
    // 仅当图已上传到对象存储（公网 http(s) URL）才回流：未配存储时是内联 data: URL，
    // 推不出 storageKey，/raw 代理取不到原图 —— 跳过而非建一条取不到图的坏素材。
    if (!/^https?:\/\//i.test(opts.imageUrl)) return;
    const storage = await getEffectiveStorage();
    if (!storage.configured) return;
    const publicBase = storage.publicUrl.replace(/\/+$/, "");
    // storageKey = 公网 URL 去掉 publicBase 前缀（与 lib/s3.ts 的拼接方式互逆）。
    // URL 不在当前存储域下（换过 bucket / 旧域名）则放弃，避免 /raw 取错对象。
    if (!opts.imageUrl.startsWith(publicBase + "/")) return;
    const storageKey = opts.imageUrl.slice(publicBase.length + 1);

    const ext = (storageKey.split(".").pop() || "png").toLowerCase();
    const mimeType = EXT_MIME[ext] ?? "image/png";
    const sizeBytes = (() => {
      const m = opts.dataUrl
        ? /^data:[^;,]+;base64,(.*)$/s.exec(opts.dataUrl)
        : null;
      const b64 = m?.[1];
      if (!b64) return 0;
      const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
      return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
    })();

    await prisma.asset.create({
      data: {
        workspaceId: opts.workspaceId,
        category: assetCategoryForScene(opts.sceneType),
        fileName: `${opts.fileLabel}.${ext === "jpeg" ? "jpg" : ext}`,
        storageKey,
        url: opts.imageUrl,
        mimeType,
        sizeBytes,
        // 见上：不改枚举，AI 来源由 generationVersionId 标识。
        source: "UPLOAD",
        generationVersionId: opts.generationVersionId,
        availableForGeneration: true,
        ...(opts.width > 0 && opts.height > 0
          ? { resolution: `${opts.width} × ${opts.height}` }
          : {}),
        ...(opts.aiDescription ? { aiDescription: opts.aiDescription } : {}),
      },
    });
  } catch (err) {
    // 幂等冲突（同一版本已回流）或任何写失败都不致命 —— 出图本身已成功。
    console.warn(
      `[asset-mirror] skip mirror for version ${opts.generationVersionId}: ${String(err)}`,
    );
  }
}
