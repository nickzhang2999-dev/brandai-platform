-- V0.0.13 · 对话面板（AI 设计师）+ 管理员图像系统提示词。
-- Generation.chatContext: 会话气泡投影（用户原文 + 引用图），frozen-additive。
-- AppSetting.imageSystemPrompt: /admin/settings/ai 配置，worker 注入
-- GenerateRequest.systemPrompt。
ALTER TABLE "Generation"
  ADD COLUMN IF NOT EXISTS "chatContext" JSONB;

ALTER TABLE "AppSetting"
  ADD COLUMN IF NOT EXISTS "imageSystemPrompt" TEXT;
