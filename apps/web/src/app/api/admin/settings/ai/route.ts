import { z } from "zod";
import { handleError, ok, parse } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { getMaskedAiSettings, updateAiSettings } from "@/lib/settings";

/**
 * Admin-only AI provider config (platform key). GET returns a masked view
 * (never the raw key); PUT updates it. Gated by ADMIN_EMAILS via requireAdmin.
 */
export async function GET() {
  try {
    await requireAdmin();
    return ok(await getMaskedAiSettings());
  } catch (err) {
    return handleError(err);
  }
}

// apiKey: omitted → unchanged; "" → clear; non-empty → set. Other fields are
// plain config; empty string clears (falls back to env).
const ProviderInput = z.object({
  provider: z.string().trim().max(64).optional(),
  baseUrl: z.string().trim().max(512).optional(),
  model: z.string().trim().max(128).optional(),
  apiKey: z.string().max(512).nullable().optional(),
});

// storage.secretKey: omitted → unchanged; "" → clear; non-empty → set
// (encrypted). Other fields are plain config; empty string clears (falls back
// to S3_* env). forcePathStyle accepts a boolean or "true"/"false" text.
const StorageInput = z.object({
  endpoint: z.string().trim().max(512).optional(),
  region: z.string().trim().max(128).optional(),
  bucket: z.string().trim().max(256).optional(),
  publicUrl: z.string().trim().max(512).optional(),
  forcePathStyle: z.union([z.boolean(), z.string().max(8)]).optional(),
  accessKey: z.string().trim().max(256).optional(),
  secretKey: z.string().max(512).nullable().optional(),
});

const UpdateInput = z.object({
  image: ProviderInput.optional(),
  vlm: ProviderInput.optional(),
  storage: StorageInput.optional(),
  // V0.0.13 — 图像系统提示词（非密）。omitted → unchanged; "" → clear.
  imageSystemPrompt: z.string().max(4000).optional(),
});

export async function PUT(req: Request) {
  try {
    const admin = await requireAdmin();
    const input = parse(UpdateInput, await req.json());
    await updateAiSettings(input, { id: admin.id, email: admin.email });
    return ok(await getMaskedAiSettings());
  } catch (err) {
    return handleError(err);
  }
}
