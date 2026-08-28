import { prisma } from "@brandai/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";

/**
 * Platform AI provider config. Source of truth is the AppSetting singleton row
 * (admin-editable); each field falls back to its env var when unset, so a
 * deploy that configured providers via CDS env keeps working until an admin
 * overrides it from the settings page.
 */
const SINGLETON = "singleton";

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface EffectiveAiSettings {
  image: ProviderConfig;
  vlm: ProviderConfig;
  /**
   * 图层分解上游（AI 分层）。刻意与 image 分开：fal 的 qwen-image-layered 是
   * 原生协议（num_layers / image_url），与 OpenAI /images/generations 形状毫无
   * 共同点，共用一组配置会让每个调用方都得先判断「这半边适用吗」。
   * 未配密钥 → provider 落到 mock，AI 服务用确定性图层兜底（零 key 可跑）。
   */
  layer: ProviderConfig;
  /**
   * V0.0.13 — admin-configured image system prompt, prepended to every
   * generation prompt by the AI service (GenerateRequest.systemPrompt).
   * Empty → nothing injected. DB wins over IMAGE_SYSTEM_PROMPT env.
   */
  imageSystemPrompt: string;
}

function safeDecrypt(blob?: string | null): string {
  if (!blob) return "";
  try {
    return decryptSecret(blob);
  } catch {
    // Orphaned ciphertext (rotated enc key) → treat as unset. This is the
    // silent "my provider/model reverted to default" cause: the stored key
    // can't be read, so the provider falls back to env/mock. Log it loudly.
    console.warn(
      "[ai-settings] a stored secret failed to decrypt (encryption key changed?) — treating as unset; effective AI config falls back to env/default.",
    );
    return "";
  }
}

/**
 * Resolve a provider name. A configured key with a blank provider almost always
 * means "I pasted a key but left the provider field empty" — defaulting that to
 * "mock" silently ignores the key (no error, no real calls). So: explicit value
 * wins; else if a key is present default to "openai"; else "mock".
 */
function resolveProvider(explicit: string, hasKey: boolean): string {
  if (explicit) return explicit;
  return hasKey ? "openai" : "mock";
}

/** Decrypted, env-merged config used to call the AI service. Server-only. */
export async function getEffectiveAiSettings(): Promise<EffectiveAiSettings> {
  const row = await prisma.appSetting.findUnique({ where: { id: SINGLETON } });
  const imageKey = safeDecrypt(row?.imageApiKey) || process.env.IMAGE_PROVIDER_API_KEY || "";
  const vlmKey = safeDecrypt(row?.vlmApiKey) || process.env.VLM_PROVIDER_API_KEY || "";
  const layerKey =
    safeDecrypt(row?.layerApiKey) || process.env.LAYER_PROVIDER_API_KEY || "";
  return {
    image: {
      provider: resolveProvider(
        row?.imageProvider || process.env.IMAGE_PROVIDER || "",
        !!imageKey,
      ),
      apiKey: imageKey,
      baseUrl: row?.imageBaseUrl || process.env.IMAGE_PROVIDER_BASE_URL || "",
      // 铁律：图像模型固定 gpt-image-2（写死默认）。AppSetting / IMAGE_MODEL env
      // 仍可覆盖（如兼容网关需命名空间 id），但无配置时一律 gpt-image-2，绝不回退
      // 上游默认（曾误用 gpt-image-1）。
      model: row?.imageModel || process.env.IMAGE_MODEL || "gpt-image-2",
    },
    vlm: {
      provider: resolveProvider(
        row?.vlmProvider || process.env.VLM_PROVIDER || "",
        !!vlmKey,
      ),
      apiKey: vlmKey,
      baseUrl: row?.vlmBaseUrl || process.env.VLM_PROVIDER_BASE_URL || "",
      model: row?.vlmModel || process.env.VLM_MODEL || "",
    },
    layer: {
      // 分层只有一家上游，所以配了密钥就默认 fal——让用户去猜 provider 名字
      // 属于「系统本来就知道却摆个空框」（最小输入原则）。
      provider: row?.layerProvider || process.env.LAYER_PROVIDER || (layerKey ? "fal" : "mock"),
      apiKey: layerKey,
      baseUrl: row?.layerBaseUrl || process.env.LAYER_PROVIDER_BASE_URL || "",
      model: row?.layerModel || process.env.LAYER_MODEL || "",
    },
    imageSystemPrompt:
      row?.imageSystemPrompt || process.env.IMAGE_SYSTEM_PROMPT || "",
  };
}

/**
 * Effective S3-compatible object storage config used to upload generated
 * images. DB (AppSetting) values win over S3_* env, which fall back to the same
 * defaults as lib/s3.ts so the internal MinIO works with no config.
 */
export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  publicUrl: string;
  forcePathStyle: boolean;
  // True only when an admin explicitly configured storage. The S3_* env points
  // at the CDS-internal MinIO (host "minio", not browser-reachable and not even
  // resolvable from the app container), so we must NOT upload generated images
  // there — callers keep the inline data: URL until real storage is configured.
  configured: boolean;
}

export async function getEffectiveStorage(): Promise<StorageConfig> {
  const row = await prisma.appSetting.findUnique({ where: { id: SINGLETON } });
  const configured = !!(
    row?.storageEndpoint ||
    row?.storagePublicUrl ||
    row?.storageBucket ||
    row?.storageAccessKey ||
    row?.storageSecretKey
  );
  const endpoint =
    row?.storageEndpoint || process.env.S3_ENDPOINT || "http://localhost:9000";
  const bucket = row?.storageBucket || process.env.S3_BUCKET || "brandai";
  const region = row?.storageRegion || process.env.S3_REGION || "us-east-1";
  const publicUrl =
    row?.storagePublicUrl || process.env.S3_PUBLIC_URL || `${endpoint}/${bucket}`;
  const accessKey =
    row?.storageAccessKey || process.env.S3_ACCESS_KEY || "minioadmin";
  const secretKey =
    safeDecrypt(row?.storageSecretKey) || process.env.S3_SECRET_KEY || "minioadmin";
  const forcePathStyle = row?.storageForcePathStyle
    ? row.storageForcePathStyle === "true"
    : process.env.S3_FORCE_PATH_STYLE !== "false";
  return { endpoint, region, bucket, accessKey, secretKey, publicUrl, forcePathStyle, configured };
}

export interface MaskedProvider {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  apiKeySet: boolean;
  envKeyPresent: boolean;
}

export interface MaskedStorage {
  endpoint: string;
  region: string;
  bucket: string;
  publicUrl: string;
  forcePathStyle: boolean;
  secretKeyMasked: string;
  secretKeySet: boolean;
  envSecretPresent: boolean;
}

export interface MaskedAiSettings {
  image: MaskedProvider;
  vlm: MaskedProvider;
  /** 图层分解上游（AI 分层）。 */
  layer: MaskedProvider;
  storage: MaskedStorage;
  /** V0.0.13 — 非密字段，admin 页直接读写。 */
  imageSystemPrompt: string;
}

/** Non-secret view for the admin page (never returns the raw key). */
export async function getMaskedAiSettings(): Promise<MaskedAiSettings> {
  const row = await prisma.appSetting.findUnique({ where: { id: SINGLETON } });
  const masked = (
    enc: string | null | undefined,
    envKey: string | undefined,
  ) => {
    const dec = safeDecrypt(enc);
    return {
      apiKeyMasked: dec ? maskSecret(dec) : "",
      apiKeySet: !!enc,
      envKeyPresent: !!envKey,
    };
  };
  const storageSecret = safeDecrypt(row?.storageSecretKey);
  return {
    image: {
      provider: row?.imageProvider ?? "",
      baseUrl: row?.imageBaseUrl ?? "",
      model: row?.imageModel ?? "",
      ...masked(row?.imageApiKey, process.env.IMAGE_PROVIDER_API_KEY),
    },
    vlm: {
      provider: row?.vlmProvider ?? "",
      baseUrl: row?.vlmBaseUrl ?? "",
      model: row?.vlmModel ?? "",
      ...masked(row?.vlmApiKey, process.env.VLM_PROVIDER_API_KEY),
    },
    layer: {
      provider: row?.layerProvider ?? "",
      baseUrl: row?.layerBaseUrl ?? "",
      model: row?.layerModel ?? "",
      ...masked(row?.layerApiKey, process.env.LAYER_PROVIDER_API_KEY),
    },
    storage: {
      endpoint: row?.storageEndpoint ?? "",
      region: row?.storageRegion ?? "",
      bucket: row?.storageBucket ?? "",
      publicUrl: row?.storagePublicUrl ?? "",
      forcePathStyle: row?.storageForcePathStyle
        ? row.storageForcePathStyle === "true"
        : process.env.S3_FORCE_PATH_STYLE !== "false",
      secretKeyMasked: storageSecret ? maskSecret(storageSecret) : "",
      secretKeySet: !!row?.storageSecretKey,
      envSecretPresent: !!process.env.S3_SECRET_KEY,
    },
    imageSystemPrompt: row?.imageSystemPrompt ?? "",
  };
}

export interface ProviderInput {
  provider?: string;
  baseUrl?: string;
  model?: string;
  // undefined → leave unchanged; "" → clear; non-empty → set (encrypted).
  apiKey?: string | null;
}

export interface StorageInput {
  endpoint?: string;
  region?: string;
  bucket?: string;
  publicUrl?: string;
  // boolean from a checkbox or "true"/"false" text — both normalized to text.
  forcePathStyle?: boolean | string;
  accessKey?: string;
  // undefined → leave unchanged; "" → clear; non-empty → set (encrypted).
  secretKey?: string | null;
}

export interface AiSettingsInput {
  image?: ProviderInput;
  vlm?: ProviderInput;
  layer?: ProviderInput;
  storage?: StorageInput;
  // undefined → leave unchanged; "" → clear (falls back to env / no prompt).
  imageSystemPrompt?: string;
}

function applyProvider(
  data: Record<string, string | null>,
  prefix: "image" | "vlm" | "layer",
  input: ProviderInput | undefined,
) {
  if (!input) return;
  if (input.provider !== undefined) data[`${prefix}Provider`] = input.provider || null;
  if (input.baseUrl !== undefined) data[`${prefix}BaseUrl`] = input.baseUrl || null;
  if (input.model !== undefined) data[`${prefix}Model`] = input.model || null;
  if (input.apiKey !== undefined) {
    data[`${prefix}ApiKey`] = input.apiKey ? encryptSecret(input.apiKey) : null;
  }
}

function applyStorage(
  data: Record<string, string | null>,
  input: StorageInput | undefined,
) {
  if (!input) return;
  if (input.endpoint !== undefined) data.storageEndpoint = input.endpoint || null;
  if (input.region !== undefined) data.storageRegion = input.region || null;
  if (input.bucket !== undefined) data.storageBucket = input.bucket || null;
  if (input.publicUrl !== undefined) data.storagePublicUrl = input.publicUrl || null;
  if (input.accessKey !== undefined) data.storageAccessKey = input.accessKey || null;
  if (input.forcePathStyle !== undefined) {
    const fps =
      typeof input.forcePathStyle === "boolean"
        ? input.forcePathStyle
        : input.forcePathStyle === "true";
    data.storageForcePathStyle = fps ? "true" : "false";
  }
  if (input.secretKey !== undefined) {
    data.storageSecretKey = input.secretKey ? encryptSecret(input.secretKey) : null;
  }
}

const SECRET_FIELDS = new Set([
  "imageApiKey",
  "vlmApiKey",
  "layerApiKey",
  "storageSecretKey",
]);

export async function updateAiSettings(
  input: AiSettingsInput,
  actor: { id: string; email?: string | null },
): Promise<void> {
  const data: Record<string, string | null> = {};
  applyProvider(data, "image", input.image);
  applyProvider(data, "vlm", input.vlm);
  applyProvider(data, "layer", input.layer);
  applyStorage(data, input.storage);
  if (input.imageSystemPrompt !== undefined) {
    data.imageSystemPrompt = input.imageSystemPrompt.trim() || null;
  }

  // Audit trail: log who changed what (secrets redacted to set/cleared), so a
  // "my model got reverted" report can be traced to an actual write vs. not.
  const before = await prisma.appSetting.findUnique({ where: { id: SINGLETON } });
  const changes: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const prev = (before as Record<string, unknown> | null)?.[k] ?? null;
    if (prev === v) continue;
    changes.push(
      SECRET_FIELDS.has(k)
        ? `${k}=${v ? "set" : "cleared"}`
        : `${k}: ${prev ?? "∅"} → ${v ?? "∅"}`,
    );
  }

  await prisma.appSetting.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, updatedById: actor.id, ...data },
    update: { updatedById: actor.id, ...data },
  });
  console.info(
    `[ai-settings] updated by ${actor.email ?? actor.id}` +
      (changes.length ? `: ${changes.join("; ")}` : " (no field changes)"),
  );
}

/**
 * Self-serve registration switch. Default CLOSED — a fresh deploy (no AppSetting
 * row yet) accepts no public sign-ups. Only the bootstrap-first-admin and
 * ADMIN_EMAILS allowlist paths bypass this (handled in the register route), so
 * an operator can always create the first account.
 */
export async function isRegistrationOpen(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { id: SINGLETON },
    select: { registrationOpen: true },
  });
  return !!row?.registrationOpen;
}

export async function setRegistrationOpen(
  open: boolean,
  actor: { id: string; email?: string | null },
): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, updatedById: actor.id, registrationOpen: open },
    update: { updatedById: actor.id, registrationOpen: open },
  });
  console.info(
    `[registration] ${open ? "OPENED" : "CLOSED"} by ${actor.email ?? actor.id}`,
  );
}

/* ------------------------------------------------------------------ *
 * 上游配置健康（谁配了、配在哪一层、是不是占位实现）
 * ------------------------------------------------------------------ */

export type ProviderSource = "db" | "env" | "none";

export interface ProviderHealth {
  /** 有没有真正可用的密钥。false = 这一路只能跑占位实现。 */
  configured: boolean;
  /** 密钥来自哪一层。none = 谁都没配。 */
  source: ProviderSource;
  /** 生效的 provider 名（不含密钥）。 */
  provider: string;
  /**
   * 部署方**明确**要求跑占位实现（env 里写死 `*_PROVIDER=mock`）。
   *
   * 这一位是「没配置」和「故意用 mock」的分界线。本地开发写 `LAYER_PROVIDER=mock`
   * 是正当的；线上一个空库既没有 db 值也没有 env 值，那就是**没配**，不该当成
   * 「选择了 mock」。
   */
  deliberateMock: boolean;
}

export interface ProvidersHealth {
  image: ProviderHealth;
  vlm: ProviderHealth;
  layer: ProviderHealth;
  storage: { configured: boolean; source: ProviderSource };
}

/**
 * 上游配置的自检快照——**不含任何密钥**，因此可以挂在无鉴权的 /api/health 上。
 *
 * 为什么要有这东西：2026-08-26 线上事故。PR 合并后 CDS 建了一个全新的 `main`
 * 部署，而 `cds-compose.yml` 里 postgres 是**每个分支各一份**——密钥存在
 * `AppSetting` 表里，也就存在旧分支自己的库里。新库是空的，于是
 * `providerHeaders()` 连请求头都不发、AI 服务落到 env、env 又没定义 `LAYER_PROVIDER`、
 * `config.py` 默认 `"mock"`，最终 `MockLayerProvider` 输出一张深色占位图，任务还标
 * SUCCEEDED。整条链每一层都"正常"，没有任何错误，用户只看到"生成的图不对"。
 *
 * 判据必须是**外部可核对**的：不登录后台、不看容器日志，`curl /api/health` 就能
 * 看出"这个部署没配 key"。
 */
export async function getProvidersHealth(): Promise<ProvidersHealth> {
  const row = await prisma.appSetting.findUnique({ where: { id: SINGLETON } });
  const line = (
    dbKey: string | null | undefined,
    envKey: string | undefined,
    dbProvider: string | null | undefined,
    envProvider: string | undefined,
    effective: string,
  ): ProviderHealth => {
    const fromDb = !!safeDecrypt(dbKey);
    const fromEnv = !!(envKey || "").trim();
    return {
      configured: fromDb || fromEnv,
      source: fromDb ? "db" : fromEnv ? "env" : "none",
      provider: effective,
      // 只有**最终真的跑 mock**时这一位才有意义。
      //
      // 第一版写成"env 或 db 里出现过 mock 就算数",拿真实部署一照就露馅:线上
      // CDS 项目 env 里留着 `IMAGE_PROVIDER=mock`(首启兜底),而 db 里是 openai——
      // 生效的是 openai,却被标成 deliberateMock=true。这一位是给守卫放行用的,
      // 误报意味着"哪天 db 值被清空、静默退回 mock"时守卫会挥手放行,正好放过
      // 它要防的那件事。
      deliberateMock:
        effective.trim().toLowerCase() === "mock" &&
        ((envProvider || "").trim().toLowerCase() === "mock" ||
          (dbProvider || "").trim().toLowerCase() === "mock"),
    };
  };
  const ai = await getEffectiveAiSettings();
  const storage = await getEffectiveStorage();
  return {
    image: line(
      row?.imageApiKey,
      process.env.IMAGE_PROVIDER_API_KEY,
      row?.imageProvider,
      process.env.IMAGE_PROVIDER,
      ai.image.provider,
    ),
    vlm: line(
      row?.vlmApiKey,
      process.env.VLM_PROVIDER_API_KEY,
      row?.vlmProvider,
      process.env.VLM_PROVIDER,
      ai.vlm.provider,
    ),
    layer: line(
      row?.layerApiKey,
      process.env.LAYER_PROVIDER_API_KEY,
      row?.layerProvider,
      process.env.LAYER_PROVIDER,
      ai.layer.provider,
    ),
    storage: {
      configured: storage.configured,
      source: row?.storageSecretKey ? "db" : storage.configured ? "env" : "none",
    },
  };
}

/**
 * 这一路上游能不能真干活。
 *
 * `false` 的含义是明确的：**没人配过它**，跑下去只会拿到占位产物。部署方明确
 * 写了 `*_PROVIDER=mock` 时返回 true —— 那是有人做过的选择，不是漏配。
 */
export function isProviderUsable(h: ProviderHealth): boolean {
  return h.configured || h.deliberateMock;
}
