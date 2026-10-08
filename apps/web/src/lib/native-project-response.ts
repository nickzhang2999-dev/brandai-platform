import { ZodError } from "zod";
import { EditorDocumentError } from "./editor-document-codec";

export const nativeResponse = (data: unknown) => Response.json({ code: 0, msg: null, data }, {
  headers: { "Cache-Control": "no-store" },
});

export function nativeErrorResponse(error: unknown) {
  let status = 500, code = 500, message = "服务暂时不可用，请保留当前内容后重试。";
  if (error instanceof EditorDocumentError) {
    status = error.status; code = error.status; message = error.message;
    if (["DOCUMENT_CONFLICT", "MUTATION_CONFLICT"].includes(error.code)) {
      // The native editor uses this exact envelope to open its conflict dialog.
      status = 200; code = 100400;
    }
  } else if (error instanceof ZodError) {
    status = code = 422; message = "项目请求格式不受支持，请刷新后重试。";
  } else if (error instanceof Error && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500) {
    status = code = error.status; message = error.message;
  }
  return Response.json({ code, msg: message, data: null }, { status, headers: { "Cache-Control": "no-store" } });
}
