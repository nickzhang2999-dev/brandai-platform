import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ApiException } from "./api";
import { uploadBuffer, getObjectStream } from "./s3";
import { nodeStreamToBuffer } from "./image-preview";
import { artifactDeadline, inspectArtifactImage, STUDIO_ARTIFACT_MAX_BYTES } from "./studio-generation-artifacts-image";

type BaseIdentity = { workspaceId: string; projectId: string; outputId: string };
export type StudioCleanBase = { schemaVersion: 1; encoding: "aes-256-gcm-v1"; objectKey: string; sha256: string;
  keyRevision: string; mimeType: string; width: number; height: number; sizeBytes: number };
const magic = Buffer.from("NSB1");
function key() {
  const material = process.env.SETTINGS_ENC_KEY || process.env.AUTH_SECRET;
  if (!material?.trim()) throw new ApiException(503, "原图保护所需的服务端加密配置缺失，请联系管理员。");
  // Separate this binary format from the existing administrator-secret format.
  return createHash("sha256").update("novart-studio-clean-base-v1\0").update(material).digest();
}
export function requireStudioBaseEncryption() { key(); }
const keyRevision = () => createHash("sha256").update("novart-studio-base-key-id\0").update(key()).digest("hex").slice(0, 24);
function identity(value: BaseIdentity) {
  if (Object.values(value).some(v => !/^[a-zA-Z0-9_-]{1,128}$/.test(v))) throw new ApiException(422, "原图保存身份无效。");
  return `${value.workspaceId}/${value.projectId}/${value.outputId}`;
}
/** Encrypt even on a legacy public bucket. A hidden object URL alone does not
 * provide private storage. Only authorized server callers receive the bytes. */
export function encryptStudioBase(body: Buffer, owner: BaseIdentity) {
  if (!body.length || body.length > STUDIO_ARTIFACT_MAX_BYTES) throw new ApiException(422, "原图超过保护存储上限。");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(identity(owner)));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
}
export function decryptStudioBase(body: Buffer, owner: BaseIdentity) {
  if (body.length <= 32 || body.length > STUDIO_ARTIFACT_MAX_BYTES + 32 || !body.subarray(0, 4).equals(magic)) throw new ApiException(422, "已保存原图格式无效。");
  const decipher = createDecipheriv("aes-256-gcm", key(), body.subarray(4, 16));
  decipher.setAAD(Buffer.from(identity(owner))); decipher.setAuthTag(body.subarray(16, 32));
  try { return Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]); }
  catch { throw new ApiException(422, "已保存原图无法验证，请检查服务端加密配置与原图完整性。"); }
}
function objectKey(owner: BaseIdentity, sha256: string, revision: string) {
  identity(owner);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !/^[a-f0-9]{24}$/.test(revision)) throw new ApiException(422, "原图校验记录无效。");
  // Old-key workers cannot overwrite the object published after a key change.
  return `${owner.workspaceId}/studio-generation-bases/${owner.projectId}/${owner.outputId}/${sha256}/${revision}`;
}
export async function storeStudioCleanBase(body: Buffer, owner: BaseIdentity, signal: AbortSignal): Promise<StudioCleanBase> {
  const meta = await inspectArtifactImage(body, signal);
  const revision = keyRevision(), encrypted = encryptStudioBase(body, owner), path = objectKey(owner, meta.sha256, revision);
  await artifactDeadline(uploadBuffer(encrypted, "application/octet-stream", `${owner.workspaceId}/studio-generation-bases/${owner.projectId}`, signal, path), signal);
  signal.throwIfAborted();
  return { schemaVersion: 1, encoding: "aes-256-gcm-v1", keyRevision: revision, objectKey: path, ...meta };
}
/** Internal only: the future edit service must first resolve owner/metadata
 * through its authorized request -> output -> successful version relation. */
export async function readStudioCleanBase(metadata: StudioCleanBase, owner: BaseIdentity, signal: AbortSignal) {
  if (metadata.schemaVersion !== 1 || metadata.encoding !== "aes-256-gcm-v1" || metadata.objectKey !== objectKey(owner, metadata.sha256, metadata.keyRevision)) throw new ApiException(422, "原图记录与当前项目不符。");
  if (metadata.keyRevision !== keyRevision()) throw new ApiException(503, "当前服务端加密配置与原图版本不符，请恢复原加密配置或完成受控迁移。");
  const response = await artifactDeadline(getObjectStream(metadata.objectKey, signal), signal);
  if (response.contentLength && response.contentLength > STUDIO_ARTIFACT_MAX_BYTES + 32) { response.body.destroy(); throw new ApiException(422, "原图超过读取上限。"); }
  const encrypted = await artifactDeadline(nodeStreamToBuffer(response.body, STUDIO_ARTIFACT_MAX_BYTES + 32, signal), signal);
  const body = decryptStudioBase(encrypted, owner), actual = await inspectArtifactImage(body, signal);
  if (actual.sha256 !== metadata.sha256 || actual.width !== metadata.width || actual.height !== metadata.height || actual.mimeType !== metadata.mimeType || actual.sizeBytes !== metadata.sizeBytes) throw new ApiException(422, "已保存原图的内容校验失败。");
  return body;
}
