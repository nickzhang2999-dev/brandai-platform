-- CreateTable
CREATE TABLE "InspirationState" (
    "workspaceId" TEXT NOT NULL,
    "activeRelease" TEXT,
    "releaseSequence" INTEGER NOT NULL DEFAULT 0,
    "withdrawalSequence" INTEGER NOT NULL DEFAULT 0,
    "withdrawalHash" TEXT,
    "withdrawn" JSONB NOT NULL DEFAULT '[]',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspirationState_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "InspirationRelease" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspirationRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspirationRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspirationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspirationImage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,

    CONSTRAINT "InspirationImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspirationChat" (
    "requestId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "caseIds" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "answer" TEXT,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspirationChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspirationBookmark" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspirationBookmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspirationEmbedding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspirationEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InspirationRelease_workspaceId_releaseId_key" ON "InspirationRelease"("workspaceId", "releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationRelease_workspaceId_sequence_key" ON "InspirationRelease"("workspaceId", "sequence");

-- CreateIndex
CREATE INDEX "InspirationRecord_workspaceId_caseId_idx" ON "InspirationRecord"("workspaceId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationRecord_workspaceId_caseId_revision_key" ON "InspirationRecord"("workspaceId", "caseId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationImage_workspaceId_releaseId_path_key" ON "InspirationImage"("workspaceId", "releaseId", "path");

-- CreateIndex
CREATE INDEX "InspirationChat_workspaceId_userId_conversationId_createdAt_idx" ON "InspirationChat"("workspaceId", "userId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "InspirationChat_status_expiresAt_idx" ON "InspirationChat"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationChat_workspaceId_userId_requestId_key" ON "InspirationChat"("workspaceId", "userId", "requestId");

-- CreateIndex
CREATE INDEX "InspirationBookmark_workspaceId_projectId_idx" ON "InspirationBookmark"("workspaceId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationBookmark_workspaceId_userId_caseId_projectId_key" ON "InspirationBookmark"("workspaceId", "userId", "caseId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "InspirationEmbedding_workspaceId_key_key" ON "InspirationEmbedding"("workspaceId", "key");

-- AddForeignKey
ALTER TABLE "InspirationState" ADD CONSTRAINT "InspirationState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationRelease" ADD CONSTRAINT "InspirationRelease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationRecord" ADD CONSTRAINT "InspirationRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationImage" ADD CONSTRAINT "InspirationImage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationChat" ADD CONSTRAINT "InspirationChat_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationBookmark" ADD CONSTRAINT "InspirationBookmark_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspirationEmbedding" ADD CONSTRAINT "InspirationEmbedding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
