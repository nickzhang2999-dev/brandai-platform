import { z } from "zod";
import { ApiException } from "./api";
import { openAiTokenOptions } from "./openai-model-options";

export type WritingModelConfig = { apiKey: string; baseUrl: string; model: string; protocol: "anthropic" | "openai" };

export function writingEndpoint(config: WritingModelConfig) {
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new ApiException(503, "文案模型地址配置无效，请管理员检查。");
  url.pathname = config.protocol === "anthropic"
    ? url.pathname.replace(/\/+$/, "").replace(/\/v1(?:\/messages)?$/, "") + "/v1/messages"
    : url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions";
  return url.toString();
}

const Block = z.discriminatedUnion("type", [z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), source: z.object({ type: z.literal("base64"), media_type: z.literal("image/jpeg"), data: z.string() }) })]);

/** One protocol per resolved config. Never retry a paid call on another route. */
export function writingRequest(config: WritingModelConfig, body: { system: string; messages: {role: string; content: unknown[]}[]; max_tokens: number }) {
  const common = { model: config.model, stream: false };
  if (config.protocol === "anthropic") return {
    endpoint: writingEndpoint(config), headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" } as Record<string,string>,
    body: { ...common, ...body, thinking: { type: "disabled" } },
  };
  const messages = body.messages.map(message => ({ role: message.role, content: message.content.map(value => {
    const block = Block.parse(value);
    return block.type === "text" ? block : { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  }) }));
  return { endpoint: writingEndpoint(config), headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` } as Record<string,string>,
    body: { ...common, ...openAiTokenOptions(config.model, body.max_tokens), response_format: { type: "json_object" }, messages: [{ role: "system", content: body.system }, ...messages] } };
}

/** Preserve missing/malformed usage for the strict result validator to reject. */
export function writingEnvelope(raw: unknown, config: WritingModelConfig): unknown {
  if (config.protocol === "anthropic") return raw;
  const value = z.object({ choices: z.array(z.object({ finish_reason: z.string(), message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }) })).min(1),
    usage: z.object({ prompt_tokens: z.unknown(), completion_tokens: z.unknown() }).optional() }).parse(raw);
  const first = value.choices[0]!;
  if (first.message.refusal || !["stop", "length"].includes(first.finish_reason)) throw new ApiException(502, "文案模型未返回可用正文，未保存结果。");
  return { stop_reason: first.finish_reason === "length" ? "max_tokens" : "end_turn", content: [{ type: "text", text: first.message.content }],
    usage: { input_tokens: value.usage?.prompt_tokens, output_tokens: value.usage?.completion_tokens } };
}
