import type {
  ComplianceCheckRequest,
  ComplianceCheckResponse,
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
} from "@brandai/contracts";
import { getEffectiveAiSettings } from "@/lib/settings";

const BASE = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

/**
 * Forward the admin-configured provider to the (stateless) AI service as
 * per-request headers (X-OV-{Image,Vlm}-*). Only sent when a key is configured;
 * absent → the AI service uses its own env/mock fallback.
 */
async function providerHeaders(): Promise<Record<string, string>> {
  const s = await getEffectiveAiSettings();
  const h: Record<string, string> = {};
  if (s.image.apiKey) {
    h["X-OV-Image-Provider"] = s.image.provider;
    h["X-OV-Image-Key"] = s.image.apiKey;
    if (s.image.baseUrl) h["X-OV-Image-Base-Url"] = s.image.baseUrl;
    if (s.image.model) h["X-OV-Image-Model"] = s.image.model;
  }
  if (s.vlm.apiKey) {
    h["X-OV-Vlm-Provider"] = s.vlm.provider;
    h["X-OV-Vlm-Key"] = s.vlm.apiKey;
    if (s.vlm.baseUrl) h["X-OV-Vlm-Base-Url"] = s.vlm.baseUrl;
    if (s.vlm.model) h["X-OV-Vlm-Model"] = s.vlm.model;
  }
  return h;
}

async function call<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await providerHeaders()) },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`AI ${path} failed: ${res.status} ${await res.text()}`);
  }
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
  generate: (b: GenerateRequest) =>
    call<GenerateRequest, GenerateResponse>("/v1/generate", b),
  edit: (b: EditRequest) => call<EditRequest, EditResponse>("/v1/edit", b),
  complianceCheck: (b: ComplianceCheckRequest) =>
    call<ComplianceCheckRequest, ComplianceCheckResponse>(
      "/v1/compliance/check",
      b,
    ),
  /**
   * Provider self-check. Reuses `call()` so the admin-configured image/vlm
   * provider headers (X-OV-*) are forwarded; the body is empty (the AI service
   * resolves providers from the headers, not the payload).
   */
  diag: () => call<Record<string, never>, DiagResponse>("/v1/diag", {}),
};
