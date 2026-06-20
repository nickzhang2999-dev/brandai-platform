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
  return {
    image: {
      provider: resolveProvider(
        row?.imageProvider || process.env.IMAGE_PROVIDER || "",
        !!imageKey,
      ),
      apiKey: imageKey,
      baseUrl: row?.imageBaseUrl || process.env.IMAGE_PROVIDER_BASE_URL || "",
      model: row?.imageModel || process.env.IMAGE_MODEL || "",
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
  storage: MaskedStorage;
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
  storage?: StorageInput;
}

function applyProvider(
  data: Record<string, string | null>,
  prefix: "image" | "vlm",
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

const SECRET_FIELDS = new Set(["imageApiKey", "vlmApiKey", "storageSecretKey"]);

export async function updateAiSettings(
  input: AiSettingsInput,
  actor: { id: string; email?: string | null },
): Promise<void> {
  const data: Record<string, string | null> = {};
  applyProvider(data, "image", input.image);
  applyProvider(data, "vlm", input.vlm);
  applyStorage(data, input.storage);

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
