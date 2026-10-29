import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { STUDIO_WRITING_FILE_MAX_BYTES } from "@brandai/contracts";
import { ApiException, requireUser } from "./api";
import { isWorkbenchSameOrigin } from "./workbench-origin";
import type { WritingScope, WritingUpload } from "./studio-writing";

export type WritingRouteContext = { params: Promise<{ wsId: string; projectId: string; taskId?: string; referenceId?: string }> };
export async function writingRouteScope(request: Request, context: WritingRouteContext, write = false, image = false): Promise<WritingScope> {
  const user = await requireUser();
  if (!image && request.headers.get("X-Novart-User") !== user.id) throw new ApiException(409, "账号已切换，请重新打开文案工作台。");
  if (write && !isWorkbenchSameOrigin(request)) throw new ApiException(403, "不接受跨站写入。");
  const { wsId, projectId } = await context.params;
  return { workspaceId: wsId, projectId, userId: user.id };
}
export function writingFailure(error: unknown) {
  const status = error instanceof ApiException ? error.status : error instanceof ZodError ? 422 : 503;
  const code = status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT"
    : status === 413 ? "TOO_LARGE" : status === 429 ? "RATE_LIMITED" : status < 500 ? "INVALID_INPUT" : "UNAVAILABLE";
  return NextResponse.json({ error: error instanceof ApiException ? error.message : error instanceof ZodError ? "请检查输入内容、选段或资料范围。" : "暂时无法处理文案请求，请稍后再试。", code }, { status, headers: { "Cache-Control": "no-store" } });
}
export const writingResponse = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
export async function readWritingUpload(request: Request): Promise<WritingUpload> {
  const maximum = STUDIO_WRITING_FILE_MAX_BYTES + 65536;
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;.*boundary=/i.test(contentType)) throw new ApiException(422, "请选择上传文件。");
  const announced = request.headers.get("content-length");
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > maximum)) throw new ApiException(413, "上传文件超过 10 MiB 限制。");
  const reader = request.body?.getReader(); if (!reader) throw new ApiException(422, "上传内容为空。");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > maximum) { await reader.cancel(); throw new ApiException(413, "上传文件超过 10 MiB 限制。"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new ApiException(422, "上传数据不完整，请重新选择文件。"); }
  if ([...form.keys()].length !== 2 || form.getAll("file").length !== 1 || form.getAll("mutationId").length !== 1) throw new ApiException(422, "上传字段无效。");
  const file = form.get("file"), mutationId = z.string().uuid().parse(form.get("mutationId"));
  if (!(file instanceof Blob) || !("name" in file) || typeof file.name !== "string") throw new ApiException(422, "上传文件无效。");
  if (!file.size || file.size > STUDIO_WRITING_FILE_MAX_BYTES) throw new ApiException(413, "单份资料须大于零且不超过 10 MiB。");
  return { mutationId, name: file.name, mimeType: file.type, body: Buffer.from(await file.arrayBuffer()) };
}
