/** One-time production model upgrade. Runs only through the versioned release contract. */
import { randomUUID, createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { prisma } from "@brandai/db";
import { getEffectiveAiSettings, getEffectiveStorage } from "../src/lib/settings";
import { runImage26Upgrade, IMAGE26_MODEL } from "../src/lib/image-model-upgrade";

let phase = "production-identity";
let upstreamHttpStatus: number | undefined;

async function main() {
  if (process.env.BRANDAI_QUEUE_PREFIX !== "brandai-prod" || !process.env.CDS_RELEASE_ID) {
    throw new Error("Production release identity required");
  }
  phase = "read-production-settings";
  const row = await prisma.appSetting.findUnique({ where: { id: "singleton" } });
  const settings = await getEffectiveAiSettings();
  const cfg = settings.image;
  const audit = await prisma.usageLog.findFirst({ where: { kind: "IMAGE_MODEL_UPGRADE", status: "SUCCEEDED", model: IMAGE26_MODEL } });
  const receipt = await runImage26Upgrade({
    previousModel: cfg.model, alreadyApplied: !!audit,
    configured: cfg.provider === "openai" && !!cfg.apiKey.trim() && !!row,
    async probe(model) {
      phase = "model-discovery";
      const response = await fetch(`${(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(20_000),
      });
      upstreamHttpStatus = response.status;
      if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
      const body = await response.json();
      return Array.isArray(body.data) && body.data.some((item: { id?: string }) => item.id === model);
    },
    async generate(model) {
      phase = "artifact-storage-precheck";
      const storage = await getEffectiveStorage();
      if (!storage.configured) throw new Error("Verification artifact storage unavailable");
      const client = new S3Client({ endpoint: storage.endpoint, region: storage.region, forcePathStyle: storage.forcePathStyle, credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey }, maxAttempts: 1 });
      phase = "real-image-generation";
      const response = await fetch(`${(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/images/generations`, {
        method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: `Production release verification ${randomUUID()}: a simple violet circle on an off-white background, no text.`, size: "1024x1024", quality: "low", n: 1, output_format: "png", safety_identifier: "production-model-upgrade" }),
        signal: AbortSignal.timeout(240_000),
      });
      upstreamHttpStatus = response.status;
      if (!response.ok) throw new Error(`Image verification HTTP ${response.status}`);
      phase = "validate-generated-image";
      const data = await response.json();
      const encoded = data.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || encoded.length > 24 * 1024 * 1024) throw new Error("Invalid verification image");
      const bytes = Buffer.from(encoded, "base64");
      const meta = await sharp(bytes, { limitInputPixels: 2_000_000 }).metadata();
      if (meta.format !== "png" || meta.width !== 1024 || meta.height !== 1024) throw new Error("Unexpected verification image dimensions");
      if (data.model != null && data.model !== model) throw new Error("Upstream returned a different model ID");
      const rawRequestId = response.headers.get("x-request-id") || response.headers.get("request-id");
      const requestId = rawRequestId && /^req_[A-Za-z0-9_-]{8,128}$/.test(rawRequestId) ? rawRequestId : null;
      const id = randomUUID();
      const key = `__model_verification/${id}`;
      const proof = { id, releaseId: process.env.CDS_RELEASE_ID, commit: process.env.CDS_COMMIT_SHA, previousModel: cfg.model, requestedModel: model, returnedModel: data.model ?? null, requestId, width: meta.width, height: meta.height, sha256: createHash("sha256").update(bytes).digest("hex"), imageKey: `${key}.png`, createdAt: new Date().toISOString() };
      phase = "persist-verification-artifacts";
      await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `${key}.png`, Body: bytes, ContentType: "image/png" }), { abortSignal: AbortSignal.timeout(20_000) });
      await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `${key}.json`, Body: JSON.stringify(proof), ContentType: "application/json" }), { abortSignal: AbortSignal.timeout(20_000) });
      return { ...proof, totalTokens: typeof data.usage?.total_tokens === "number" ? data.usage.total_tokens : null };
    },
    async persist(model, proof) {
      phase = "compare-and-set-production-model";
      await prisma.$transaction(async tx => {
        const updated = await tx.appSetting.updateMany({ where: { id: "singleton", updatedAt: row!.updatedAt }, data: { imageModel: model } });
        if (updated.count !== 1) throw new Error("Production settings changed during verification");
        await tx.usageLog.create({ data: { id: proof.id, workspaceId: "system:production-image-model-upgrade", kind: "IMAGE_MODEL_UPGRADE", status: "SUCCEEDED", provider: "openai", model, size: "1024x1024", imageCount: 1, totalTokens: proof.totalTokens } });
      });
    },
  });
  const actual = await getEffectiveAiSettings();
  if (receipt.status === "applied" && actual.image.model !== IMAGE26_MODEL) throw new Error("Production model readback mismatch");
  console.log(JSON.stringify({ event: "production-image-model-upgrade", ...receipt }));
}
main().catch(() => { console.error(JSON.stringify({ event: "production-image-model-upgrade", status: "FAILED", phase, upstreamHttpStatus })); process.exitCode = 1; }).finally(() => prisma.$disconnect());
