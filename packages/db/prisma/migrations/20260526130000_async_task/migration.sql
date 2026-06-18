-- H-async 异步任务全面服务器权威 — task rows for recognize / parse-manual / edit
-- so they're refresh-resumable with a real progress %. Additive (new table).
CREATE TABLE "AsyncTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "jobId" TEXT,
    "refId" TEXT,
    "refCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AsyncTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AsyncTask_workspaceId_kind_createdAt_idx"
  ON "AsyncTask"("workspaceId", "kind", "createdAt");
