import { AiFailureResponse, type AiFailureInfo } from "@brandai/contracts";
import { readBoundedAiJson } from "./ai-response";

const messages: Record<AiFailureInfo["code"], string> = {
  SOURCE_UNAVAILABLE: "参考图片读取失败，尚未提交给图片模型。请检查图片后重新提交。",
  PROVIDER_RATE_LIMITED: "图片模型暂时限制请求，本次未取得结果。系统不会自动重新生成；请稍后再试。",
  PROVIDER_AUTH: "图片模型授权失败，请联系管理员检查模型配置。",
  PROVIDER_REQUEST_REJECTED: "图片模型未接受本次请求，请联系管理员核对图片和模型参数。",
  PROVIDER_UNAVAILABLE: "图片模型或网关暂时异常，本次未取得结果。系统不会自动重新生成；请稍后检查任务结果。",
  PROVIDER_TIMEOUT: "等待图片模型响应超时，暂未取得结果。上游可能仍在处理，系统不会自动重新生成。",
  PROVIDER_NETWORK: "连接图片模型时发生网络异常，暂未取得结果。系统不会自动重新生成。",
  PROVIDER_INVALID_RESPONSE: "图片模型返回了无法使用的结果，未替换原图。系统不会自动重新生成。",
  AI_REQUEST_FAILED: "图片服务请求失败，具体原因尚未确认。系统不会自动重新生成。",
};

export class AiServiceFailure extends Error {
  constructor(readonly info: AiFailureInfo) {
    super(messages[info.code]);
    this.name = "AiServiceFailure";
  }
}

export async function readAiFailure(response: Response, parentSignal?: AbortSignal): Promise<Error> {
  // An unhealthy gateway may send HTML, huge bodies or a stalled stream.
  // Bound diagnostic parsing separately; never delay the job until its TTL.
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(1500)])
    : AbortSignal.timeout(1500);
  try {
    const result = AiFailureResponse.safeParse(await readBoundedAiJson(response, signal, 4096));
    if (result.success) return new AiServiceFailure(result.data.error);
  } catch { /* Keep the older status-only fallback; never expose raw body. */ }
  return new Error(`图片服务请求失败（HTTP ${response.status}），请稍后重试或联系管理员。`);
}
