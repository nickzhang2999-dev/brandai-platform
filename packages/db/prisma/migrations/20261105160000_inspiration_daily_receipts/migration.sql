CREATE TABLE "InspirationImageReceipt" (
  "ownerId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "receivedDay" TEXT,
  "receivedAt" TIMESTAMP(3),
  "libraryId" TEXT,
  "releaseId" TEXT,
  CONSTRAINT "InspirationImageReceipt_pkey" PRIMARY KEY ("ownerId", "sha256"),
  CONSTRAINT "InspirationImageReceipt_hash_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "InspirationImageReceipt_day_check" CHECK (("receivedDay" IS NULL) = ("receivedAt" IS NULL))
);
CREATE INDEX "InspirationImageReceipt_ownerId_receivedDay_idx" ON "InspirationImageReceipt"("ownerId", "receivedDay");
CREATE TABLE "InspirationDailyPolicy" (
  "ownerId" TEXT NOT NULL PRIMARY KEY,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startDay" TEXT NOT NULL,
  "target" INTEGER NOT NULL DEFAULT 100 CHECK ("target" IN (100, 200, 300)),
  "qualityDay" TEXT,
  "qualityEvidence" TEXT,
  "qualityReviewedBy" TEXT,
  "qualityReviewedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
