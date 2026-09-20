-- Worker-generated, bounded WebP used by the authenticated canvas preview route.
-- Nullable keeps the migration additive and lets legacy assets backfill lazily.
ALTER TABLE "Asset" ADD COLUMN "previewStorageKey" TEXT;
