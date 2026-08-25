-- 图层分解上游配置（AI 分层）。与 image/vlm 分开：fal qwen-image-layered
-- 是原生协议，和 OpenAI /images/generations 形状不同。
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "layerProvider" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "layerApiKey" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "layerBaseUrl" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "layerModel" TEXT;
