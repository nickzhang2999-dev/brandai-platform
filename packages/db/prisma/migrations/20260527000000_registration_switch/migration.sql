-- 注册开关:默认关闭(仅管理员可开;bootstrap/ADMIN_EMAILS 例外在 register 路由处理)。
ALTER TABLE "AppSetting" ADD COLUMN "registrationOpen" BOOLEAN NOT NULL DEFAULT false;
