import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (admin-supplied AI provider keys). The key is
 * derived from SETTINGS_ENC_KEY (preferred) or AUTH_SECRET via SHA-256, so no
 * extra env is mandatory in a deploy that already sets AUTH_SECRET. Rotating
 * that material orphans previously-stored ciphertext (decrypt fails → treated
 * as unset), which is the safe failure mode.
 *
 * Format: "v1.<iv b64>.<tag b64>.<ciphertext b64>".
 */
function encKey(): Buffer {
  const material = process.env.SETTINGS_ENC_KEY || process.env.AUTH_SECRET || "";
  if (!material) {
    throw new Error(
      "SETTINGS_ENC_KEY or AUTH_SECRET must be set to encrypt admin secrets",
    );
  }
  return createHash("sha256").update(material).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

export function decryptSecret(blob: string): string {
  const [v, ivB, tagB, ctB] = blob.split(".");
  if (v !== "v1" || !ivB || !tagB || !ctB) {
    throw new Error("malformed secret blob");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encKey(),
    Buffer.from(ivB, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Render a secret for display: keep head/tail, hide the middle. */
export function maskSecret(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 8) return "****";
  return `${plain.slice(0, 3)}…${plain.slice(-4)}`;
}
