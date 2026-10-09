import type {
  ComplianceCheckRequest,
  ComplianceCheckResponse,
  DecomposeRequest,
  DecomposeResponse,
  DescribeRequest,
  DescribeResponse,
  DiagResponse,
  EditRequest,
  EditResponse,
  GenerateRequest,
  GenerateResponse,
  IngestWebsiteRequest,
  IngestWebsiteResponse,
  ParseManualRequest,
  ParseManualResponse,
  RecognizeRequest,
  RecognizeResponse,
  SummarizeRequest,
  SummarizeResponse,
} from "@brandai/contracts";
import { resolveAiService } from "@/lib/ai-service";
import { getEffectiveAiSettings } from "@/lib/settings";
import { readBoundedAiJson, withinAiDeadline, type AiCallOptions } from "@/lib/ai-response";

/**
 * Forward the admin-configured provider to the (stateless) AI service as
 * per-request headers (X-OV-{Image,Vlm}-*). Only sent when a key is configured;
 * absent → the AI service uses its own env/mock fallback.
 */
async function providerHeaders(requireRealImageProvider = false, requireRealVlmProvider = false): Promise<Record<string, string>> {
  const s = await getEffectiveAiSettings();
  // Validate the same snapshot that produces the outgoing headers. A separate
  // intake/claim check cannot prevent configuration changing while queued.
  const imageProvider = s.image.provider?.trim().toLowerCase();
  if (requireRealImageProvider && (!imageProvider || imageProvider === "mock" || !s.image.apiKey?.trim())) {
    throw new Error("真实图片生成服务配置已不可用，任务未调用演示模型。请联系管理员检查配置。");
  }
  const vlmProvider = s.vlm.provider?.trim().toLowerCase();
  if (requireRealVlmProvider && (!vlmProvider || vlmProvider === "mock" || !s.vlm.apiKey?.trim())) {
    throw new Error("真实图片检查服务尚未配置，未执行品牌检查。请联系管理员检查配置。");
  }
  const h: Record<string, string> = {};
  if (s.image.apiKey) {
    h["X-OV-Image-Provider"] = s.image.provider;
    h["X-OV-Image-Key"] = s.image.apiKey;
    if (s.image.baseUrl) h["X-OV-Image-Base-Url"] = s.image.baseUrl;
    if (s.image.model) h["X-OV-Image-Model"] = s.image.model;
  }
  if (s.layer.apiKey) {
    h["X-OV-Layer-Provider"] = s.layer.provider;
    h["X-OV-Layer-Key"] = s.layer.apiKey;
    if (s.layer.baseUrl) h["X-OV-Layer-Base-Url"] = s.layer.baseUrl;
    if (s.layer.model) h["X-OV-Layer-Model"] = s.layer.model;
  }
  if (s.vlm.apiKey) {
    h["X-OV-Vlm-Provider"] = s.vlm.provider;
    h["X-OV-Vlm-Key"] = s.vlm.apiKey;
    if (s.vlm.baseUrl) h["X-OV-Vlm-Base-Url"] = s.vlm.baseUrl;
    if (s.vlm.model) h["X-OV-Vlm-Model"] = s.vlm.model;
  }
  return h;
}

async function call<TReq, TRes>(path: string, body: TReq, options?: AiCallOptions): Promise<TRes> {
  const signal = options ? options.signal ?? AbortSignal.timeout(5 * 60_000) : undefined;
  signal?.throwIfAborted();
  const requireVisualCheck = path === "/v1/compliance/check" && options?.requireRealVlmProvider === true;
  const setup = Promise.all([resolveAiService(requireVisualCheck ? { requireVisualCheck: true } : undefined), providerHeaders(
    path === "/v1/generate" && options?.requireRealImageProvider === true,
    requireVisualCheck,
  )]);
  const [service, headers] = await (signal ? withinAiDeadline(setup, signal) : setup);
  signal?.throwIfAborted();
  const res = await fetch(`${service.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    if (options) {
      // Provider error bodies may contain URLs, keys or user prompts.
      void res.body?.cancel().catch(() => undefined);
      throw new Error(`图片服务请求失败（HTTP ${res.status}），请稍后重试或联系管理员。`);
    }
    throw new Error(`AI ${path} failed: ${res.status} ${await res.text()}`);
  }
  if (signal) return readBoundedAiJson<TRes>(res, signal, options?.maxResponseBytes ?? 48 * 1024 * 1024);
  return (await res.json()) as TRes;
}

export const ai = {
  ingestWebsite: (b: IngestWebsiteRequest) =>
    call<IngestWebsiteRequest, IngestWebsiteResponse>(
      "/v1/ingest/website",
      b,
    ),
  recognize: (b: RecognizeRequest) =>
    call<RecognizeRequest, RecognizeResponse>("/v1/recognize", b),
  describe: (b: DescribeRequest) =>
    call<DescribeRequest, DescribeResponse>("/v1/describe", b),
  parseManual: (b: ParseManualRequest) =>
    call<ParseManualRequest, ParseManualResponse>("/v1/parse-manual", b),
  summarize: (b: SummarizeRequest) =>
    call<SummarizeRequest, SummarizeResponse>("/v1/summarize", b),
  generate: (b: GenerateRequest, options?: AiCallOptions) =>
    call<GenerateRequest, GenerateResponse>("/v1/generate", b, options),
  edit: (b: EditRequest) => call<EditRequest, EditResponse>("/v1/edit", b),
  /**
   * 图层分解。只有 worker 该调它——实测真上游 12–42 秒，第一次调用就打穿
   * 30 秒边缘网关上限（§2.1：AI 调用不许出现在 HTTP handler 里）。
   */
  decompose: (b: DecomposeRequest) =>
    call<DecomposeRequest, DecomposeResponse>("/v1/decompose", b),
  complianceCheck: (b: ComplianceCheckRequest, options?: AiCallOptions) =>
    call<ComplianceCheckRequest, ComplianceCheckResponse>(
      "/v1/compliance/check",
      b,
      options,
    ),
  /**
   * Provider self-check. Reuses `call()` so the admin-configured image/vlm
   * provider headers (X-OV-*) are forwarded; the body is empty (the AI service
   * resolves providers from the headers, not the payload).
   */
  diag: () => call<Record<string, never>, DiagResponse>("/v1/diag", {}),
};
