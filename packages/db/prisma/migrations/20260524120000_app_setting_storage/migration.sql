-- Generated-image object storage config on the AppSetting singleton. All
-- columns are additive and nullable; empty fields fall back to the S3_* env
-- vars so the existing internal MinIO keeps working out of the box.
-- "storageSecretKey" stores AES-256-GCM ciphertext (like imageApiKey).
-- "storageForcePathStyle" stores the text "true"/"false" to mirror the
-- DB-value || env merge pattern used by the other columns.

ALTER TABLE "AppSetting" ADD COLUMN "storageEndpoint" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "storageRegion" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "storageBucket" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "storageAccessKey" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "storageSecretKey" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "storagePublicUrl" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "storageForcePathStyle" TEXT;
