-- Admin AI settings: singleton runtime config so an admin can set the platform
-- provider/key/model from a settings page instead of redeploying with env.
-- apiKey columns store AES-256-GCM ciphertext; empty fields fall back to env.

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "imageProvider" TEXT,
    "imageApiKey" TEXT,
    "imageBaseUrl" TEXT,
    "imageModel" TEXT,
    "vlmProvider" TEXT,
    "vlmApiKey" TEXT,
    "vlmBaseUrl" TEXT,
    "vlmModel" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);
