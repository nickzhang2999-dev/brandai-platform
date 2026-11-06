-- AlterTable
ALTER TABLE "InspirationImageReceipt" ADD COLUMN     "initializationId" TEXT;

-- A dated daily gain, an undated verified legacy baseline, and an explicitly
-- authorized initialization are distinct accounting events.
ALTER TABLE "InspirationImageReceipt" DROP CONSTRAINT "InspirationImageReceipt_day_check";
ALTER TABLE "InspirationImageReceipt" ADD CONSTRAINT "InspirationImageReceipt_day_check" CHECK (
  ("receivedDay" IS NULL AND "receivedAt" IS NULL AND "initializationId" IS NULL)
  OR ("receivedDay" IS NOT NULL AND "receivedAt" IS NOT NULL AND "initializationId" IS NULL)
  OR ("receivedDay" IS NULL AND "receivedAt" IS NOT NULL AND "initializationId" IS NOT NULL)
);
ALTER TABLE "InspirationDailyPolicy" DROP CONSTRAINT "InspirationDailyPolicy_target_check";
ALTER TABLE "InspirationDailyPolicy" ADD CONSTRAINT "InspirationDailyPolicy_target_check" CHECK ("target" IN (100,200,300,400,500));

-- CreateTable
CREATE TABLE "InspirationSnapshotImport" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "rootHash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "nextPart" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspirationSnapshotImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspirationSnapshotObject" (
    "libraryId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspirationSnapshotObject_pkey" PRIMARY KEY ("libraryId","sha256")
);

-- CreateTable
CREATE TABLE "InspirationSnapshotCatalogPart" (
    "libraryId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspirationSnapshotCatalogPart_pkey" PRIMARY KEY ("libraryId","sha256")
);

-- CreateTable
CREATE TABLE "InspirationSnapshotCatalogEntry" (
    "libraryId" TEXT NOT NULL,
    "partHash" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "industry" TEXT[],
    "medium" TEXT[],
    "task" TEXT[],

    CONSTRAINT "InspirationSnapshotCatalogEntry_pkey" PRIMARY KEY ("libraryId","partHash","caseId")
);

-- CreateTable
CREATE TABLE "InspirationSnapshotPartObject" (
    "libraryId" TEXT NOT NULL,
    "partHash" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,

    CONSTRAINT "InspirationSnapshotPartObject_pkey" PRIMARY KEY ("libraryId","partHash","path")
);

-- CreateTable
CREATE TABLE "InspirationSnapshotImportPart" (
    "importId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "libraryId" TEXT NOT NULL,
    "partHash" TEXT NOT NULL,

    CONSTRAINT "InspirationSnapshotImportPart_pkey" PRIMARY KEY ("importId","ordinal")
);

-- CreateTable
CREATE TABLE "InspirationSnapshotReleasePart" (
    "libraryId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "partHash" TEXT NOT NULL,

    CONSTRAINT "InspirationSnapshotReleasePart_pkey" PRIMARY KEY ("libraryId","releaseId","ordinal")
);

-- CreateIndex
CREATE INDEX "InspirationSnapshotImport_libraryId_status_idx" ON "InspirationSnapshotImport"("libraryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationSnapshotImport_libraryId_releaseId_key" ON "InspirationSnapshotImport"("libraryId", "releaseId");

-- CreateIndex
CREATE INDEX "InspirationSnapshotCatalogEntry_recordId_idx" ON "InspirationSnapshotCatalogEntry"("recordId");

-- CreateIndex
CREATE INDEX "InspirationSnapshotCatalogEntry_libraryId_contentType_idx" ON "InspirationSnapshotCatalogEntry"("libraryId", "contentType");

-- CreateIndex
CREATE INDEX "InspirationSnapshotCatalogEntry_industry_idx" ON "InspirationSnapshotCatalogEntry" USING GIN ("industry");

-- CreateIndex
CREATE INDEX "InspirationSnapshotCatalogEntry_medium_idx" ON "InspirationSnapshotCatalogEntry" USING GIN ("medium");

-- CreateIndex
CREATE INDEX "InspirationSnapshotCatalogEntry_task_idx" ON "InspirationSnapshotCatalogEntry" USING GIN ("task");

-- CreateIndex
CREATE INDEX "InspirationSnapshotPartObject_libraryId_sha256_idx" ON "InspirationSnapshotPartObject"("libraryId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationSnapshotImportPart_importId_partHash_key" ON "InspirationSnapshotImportPart"("importId", "partHash");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationSnapshotReleasePart_libraryId_releaseId_partHash_key" ON "InspirationSnapshotReleasePart"("libraryId", "releaseId", "partHash");

-- CreateIndex
CREATE INDEX "InspirationImageReceipt_ownerId_initializationId_idx" ON "InspirationImageReceipt"("ownerId", "initializationId");

-- AddForeignKey
ALTER TABLE "InspirationSnapshotImport" ADD CONSTRAINT "InspirationSnapshotImport_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotObject" ADD CONSTRAINT "InspirationSnapshotObject_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotCatalogPart" ADD CONSTRAINT "InspirationSnapshotCatalogPart_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotCatalogEntry" ADD CONSTRAINT "InspirationSnapshotCatalogEntry_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "InspirationLibraryRecord"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotCatalogEntry" ADD CONSTRAINT "InspirationSnapshotCatalogEntry_libraryId_partHash_fkey" FOREIGN KEY ("libraryId", "partHash") REFERENCES "InspirationSnapshotCatalogPart"("libraryId", "sha256") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotPartObject" ADD CONSTRAINT "InspirationSnapshotPartObject_libraryId_partHash_fkey" FOREIGN KEY ("libraryId", "partHash") REFERENCES "InspirationSnapshotCatalogPart"("libraryId", "sha256") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotImportPart" ADD CONSTRAINT "InspirationSnapshotImportPart_importId_fkey" FOREIGN KEY ("importId") REFERENCES "InspirationSnapshotImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotImportPart" ADD CONSTRAINT "InspirationSnapshotImportPart_libraryId_partHash_fkey" FOREIGN KEY ("libraryId", "partHash") REFERENCES "InspirationSnapshotCatalogPart"("libraryId", "sha256") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotReleasePart" ADD CONSTRAINT "InspirationSnapshotReleasePart_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "InspirationLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationSnapshotReleasePart" ADD CONSTRAINT "InspirationSnapshotReleasePart_libraryId_partHash_fkey" FOREIGN KEY ("libraryId", "partHash") REFERENCES "InspirationSnapshotCatalogPart"("libraryId", "sha256") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Existing library/account deletion cascades traverse both records and parts.
-- Defer these cross-branch references until commit, so their deletion ordering
-- does not block a complete cascade. Independent deletion still fails at commit.
ALTER TABLE "InspirationSnapshotCatalogEntry" ALTER CONSTRAINT "InspirationSnapshotCatalogEntry_recordId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "InspirationSnapshotImportPart" ALTER CONSTRAINT "InspirationSnapshotImportPart_libraryId_partHash_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "InspirationSnapshotReleasePart" ALTER CONSTRAINT "InspirationSnapshotReleasePart_libraryId_partHash_fkey" DEFERRABLE INITIALLY DEFERRED;
