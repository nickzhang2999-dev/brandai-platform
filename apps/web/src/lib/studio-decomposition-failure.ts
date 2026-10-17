import { AiServiceFailure } from "./ai-failure";

/** Only the allowlisted error contract is user-visible, never upstream text. */
export function studioDecompositionFailure(error: unknown, analysis: boolean): string {
  const service = analysis ? "图片内容分析服务" : "图层分解服务";
  const suffix = analysis
    ? "未调用分层模型，原图片保留；系统不会自动重复付费分析。"
    : "原图片保留；系统不会自动重复调用分层模型。";
  if (error instanceof AiServiceFailure) {
    const messages: Record<typeof error.info.code, string> = {
      SOURCE_UNAVAILABLE: "原图片读取失败。",
      PROVIDER_AUTH: `${service}授权失败，请管理员检查对应模型凭据。`,
      PROVIDER_REQUEST_REJECTED: `${service}拒绝了请求，请管理员检查模型与请求参数。`,
      PROVIDER_RATE_LIMITED: `${service}触发限流，请稍后再提交。`,
      PROVIDER_UNAVAILABLE: `${service}或上游网关暂时不可用。`,
      PROVIDER_TIMEOUT: `${service}响应超时，上游可能仍在处理。`,
      PROVIDER_NETWORK: `连接${service}时发生网络异常。`,
      PROVIDER_INVALID_RESPONSE: `${service}返回的内容不完整或格式无效。`,
      AI_REQUEST_FAILED: `${service}请求失败，具体原因尚未确认。`,
    };
    const status = error.info.upstreamStatus;
    return messages[error.info.code] + (status && Number.isInteger(status) && status >= 400 && status <= 599 ? `（上游 HTTP ${status}）` : "") + suffix;
  }
  return analysis ? "图片内容分析未完成，未调用分层模型。原图片已保留，系统不会自动重复付费分析。"
    : "AI 分层或图层保存未完成。原图片保持不变；已有模型结果可尝试重新保存，不会自动重复调用模型。";
}
