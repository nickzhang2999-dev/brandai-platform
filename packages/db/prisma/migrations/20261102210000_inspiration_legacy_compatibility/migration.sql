BEGIN;
SET LOCAL lock_timeout = '5s';

-- Main and the library preview share PostgreSQL. Keep the main SQL interface
-- private and isolate every new replica, conversation, cache and queue write.
-- Quiesce admission before checking tasks; no silent cancellation or retry.
LOCK TABLE "AsyncTask" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "InspirationState", "InspirationRelease", "InspirationRecord", "InspirationImage", "InspirationChat", "InspirationBookmark", "InspirationEmbedding", "InspirationFeedback" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AsyncTask" WHERE "kind" IN ('INSPIRATION_SYNC','INSPIRATION_CHAT') AND "status"::text IN ('PENDING','RUNNING'))
     OR EXISTS (SELECT 1 FROM "InspirationChat" WHERE "status"::text IN ('PENDING','RUNNING')) THEN
    RAISE EXCEPTION 'Stop and resolve active inspiration tasks before library isolation' USING ERRCODE = '55000';
  END IF;
END;
$$;


ALTER TABLE "InspirationState" RENAME TO "InspirationLibraryState";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryState"'::regclass
    AND left(conname,17)='InspirationState_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryState',item.conname,'InspirationLibraryState'||substr(item.conname,17));
  END LOOP;
END;
$$;

ALTER TABLE "InspirationRelease" RENAME TO "InspirationLibraryRelease";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryRelease"'::regclass
    AND left(conname,19)='InspirationRelease_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryRelease',item.conname,'InspirationLibraryRelease'||substr(item.conname,19));
  END LOOP;
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryRelease"'::regclass AND NOT i.indisprimary AND i.indisunique=true
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['libraryId','releaseId']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryRelease_identity_key');
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryRelease"'::regclass AND NOT i.indisprimary AND i.indisunique=true
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['libraryId','sequence']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryRelease_sequence_key');
END;
$$;

ALTER TABLE "InspirationRecord" RENAME TO "InspirationLibraryRecord";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryRecord"'::regclass
    AND left(conname,18)='InspirationRecord_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryRecord',item.conname,'InspirationLibraryRecord'||substr(item.conname,18));
  END LOOP;
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryRecord"'::regclass AND NOT i.indisprimary AND i.indisunique=false
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['libraryId','caseId']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryRecord_case_idx');
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryRecord"'::regclass AND NOT i.indisprimary AND i.indisunique=true
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['libraryId','caseId','revision']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryRecord_revision_key');
END;
$$;

ALTER TABLE "InspirationImage" RENAME TO "InspirationLibraryImage";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryImage"'::regclass
    AND left(conname,17)='InspirationImage_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryImage',item.conname,'InspirationLibraryImage'||substr(item.conname,17));
  END LOOP;
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryImage"'::regclass AND NOT i.indisprimary AND i.indisunique=true
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['libraryId','releaseId','path']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryImage_file_key');
END;
$$;

ALTER TABLE "InspirationChat" RENAME TO "InspirationLibraryChat";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryChat"'::regclass
    AND left(conname,16)='InspirationChat_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryChat',item.conname,'InspirationLibraryChat'||substr(item.conname,16));
  END LOOP;
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryChat"'::regclass AND NOT i.indisprimary AND i.indisunique=false
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['workspaceId','userId','conversationId','createdAt']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryChat_conversation_idx');
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryChat"'::regclass AND NOT i.indisprimary AND i.indisunique=false
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['status','expiresAt']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryChat_status_idx');
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryChat"'::regclass AND NOT i.indisprimary AND i.indisunique=true
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['workspaceId','userId','requestId']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryChat_request_key');
END;
$$;

ALTER TABLE "InspirationBookmark" RENAME TO "InspirationLibraryBookmark";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryBookmark"'::regclass
    AND left(conname,20)='InspirationBookmark_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryBookmark',item.conname,'InspirationLibraryBookmark'||substr(item.conname,20));
  END LOOP;
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryBookmark"'::regclass AND NOT i.indisprimary AND i.indisunique=false
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['workspaceId','projectId']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryBookmark_project_idx');
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryBookmark"'::regclass AND NOT i.indisprimary AND i.indisunique=true
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['workspaceId','userId','libraryId','caseId','projectId']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryBookmark_identity_key');
END;
$$;

ALTER TABLE "InspirationEmbedding" RENAME TO "InspirationLibraryEmbedding";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryEmbedding"'::regclass
    AND left(conname,21)='InspirationEmbedding_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryEmbedding',item.conname,'InspirationLibraryEmbedding'||substr(item.conname,21));
  END LOOP;
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryEmbedding"'::regclass AND NOT i.indisprimary AND i.indisunique=true
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['workspaceId','key']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryEmbedding_identity_key');
END;
$$;

ALTER TABLE "InspirationFeedback" RENAME TO "InspirationLibraryFeedback";

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='"InspirationLibraryFeedback"'::regclass
    AND left(conname,20)='InspirationFeedback_' LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I','InspirationLibraryFeedback',item.conname,'InspirationLibraryFeedback'||substr(item.conname,20));
  END LOOP;
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryFeedback"'::regclass AND NOT i.indisprimary AND i.indisunique=false
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['workspaceId','userId','createdAt']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryFeedback_user_idx');
END;
$$;

DO $$
DECLARE prior_name text;
BEGIN
  SELECT index_class.relname INTO STRICT prior_name
  FROM pg_index i JOIN pg_class index_class ON index_class.oid=i.indexrelid
  WHERE i.indrelid='"InspirationLibraryFeedback"'::regclass AND NOT i.indisprimary AND i.indisunique=false
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)=ARRAY['workspaceId','status','createdAt']::text[];
  EXECUTE format('ALTER INDEX %I RENAME TO %I',prior_name,'InspirationLibraryFeedback_status_idx');
END;
$$;

-- Recreate main's original private tables, constraints and unique keys.
-- Original current rows remain intact in the renamed library tables.

CREATE TABLE "InspirationState" (
    "workspaceId" TEXT NOT NULL,
    "activeRelease" TEXT,
    "releaseSequence" INTEGER NOT NULL DEFAULT 0,
    "withdrawalSequence" INTEGER NOT NULL DEFAULT 0,
    "withdrawalHash" TEXT,
    "withdrawn" JSONB NOT NULL DEFAULT '[]',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastSyncAttemptAt" TIMESTAMP(3),
    "lastSyncFailedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "lastWithdrawalAttemptAt" TIMESTAMP(3),
    "lastWithdrawalAt" TIMESTAMP(3),
    "lastWithdrawalFailedAt" TIMESTAMP(3),
    "withdrawalError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspirationState_pkey" PRIMARY KEY ("workspaceId")
);

ALTER TABLE "InspirationState" ADD CONSTRAINT "InspirationState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

CREATE UNIQUE INDEX "InspirationRelease_workspaceId_releaseId_key" ON "InspirationRelease"("workspaceId", "releaseId");

CREATE UNIQUE INDEX "InspirationRelease_workspaceId_sequence_key" ON "InspirationRelease"("workspaceId", "sequence");

ALTER TABLE "InspirationRelease" ADD CONSTRAINT "InspirationRelease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

CREATE INDEX "InspirationRecord_workspaceId_caseId_idx" ON "InspirationRecord"("workspaceId", "caseId");

CREATE UNIQUE INDEX "InspirationRecord_workspaceId_caseId_revision_key" ON "InspirationRecord"("workspaceId", "caseId", "revision");

ALTER TABLE "InspirationRecord" ADD CONSTRAINT "InspirationRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

CREATE UNIQUE INDEX "InspirationImage_workspaceId_releaseId_path_key" ON "InspirationImage"("workspaceId", "releaseId", "path");

ALTER TABLE "InspirationImage" ADD CONSTRAINT "InspirationImage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InspirationChat" (
    "selectedImages" JSONB NOT NULL DEFAULT '[]',
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
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

CREATE INDEX "InspirationChat_workspaceId_userId_conversationId_createdAt_idx" ON "InspirationChat"("workspaceId", "userId", "conversationId", "createdAt");

CREATE INDEX "InspirationChat_status_expiresAt_idx" ON "InspirationChat"("status", "expiresAt");

CREATE UNIQUE INDEX "InspirationChat_workspaceId_userId_requestId_key" ON "InspirationChat"("workspaceId", "userId", "requestId");

ALTER TABLE "InspirationChat" ADD CONSTRAINT "InspirationChat_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

CREATE INDEX "InspirationBookmark_workspaceId_projectId_idx" ON "InspirationBookmark"("workspaceId", "projectId");

CREATE UNIQUE INDEX "InspirationBookmark_workspaceId_userId_caseId_projectId_key" ON "InspirationBookmark"("workspaceId", "userId", "caseId", "projectId");

ALTER TABLE "InspirationBookmark" ADD CONSTRAINT "InspirationBookmark_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InspirationEmbedding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspirationEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InspirationEmbedding_workspaceId_key_key" ON "InspirationEmbedding"("workspaceId", "key");

ALTER TABLE "InspirationEmbedding" ADD CONSTRAINT "InspirationEmbedding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InspirationFeedback" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspirationFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InspirationFeedback_workspaceId_userId_createdAt_idx" ON "InspirationFeedback"("workspaceId", "userId", "createdAt");

CREATE INDEX "InspirationFeedback_workspaceId_status_createdAt_idx" ON "InspirationFeedback"("workspaceId", "status", "createdAt");

ALTER TABLE "InspirationFeedback" ADD CONSTRAINT "InspirationFeedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InspirationLibraryTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "inspirationLibraryId" TEXT,
    "kind" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "jobId" TEXT,
    "refId" TEXT,
    "refCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "inputJson" JSONB,
    "resultJson" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspirationLibraryTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InspirationLibraryTask_workspace_idx" ON "InspirationLibraryTask"("workspaceId", "kind", "createdAt");

CREATE INDEX "InspirationLibraryTask_library_idx" ON "InspirationLibraryTask"("inspirationLibraryId", "kind", "createdAt");

CREATE INDEX "InspirationLibraryTask_ref_idx" ON "InspirationLibraryTask"("refId");

ALTER TABLE "InspirationLibraryTask" ADD CONSTRAINT "InspirationLibraryTask_inspirationLibraryId_fkey" FOREIGN KEY ("inspirationLibraryId") REFERENCES "InspirationLibrary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InspirationFeedback"
  ADD CONSTRAINT "InspirationFeedback_revision_check" CHECK ("revision">0),
  ADD CONSTRAINT "InspirationFeedback_kind_check" CHECK ("kind" IN ('IRRELEVANT','ANALYSIS_ERROR','UNSUPPORTED_CITATION','BROKEN_IMAGE')),
  ADD CONSTRAINT "InspirationFeedback_status_check" CHECK ("status" IN ('OPEN','RESOLVED')),
  ADD CONSTRAINT "InspirationFeedback_note_check" CHECK (char_length("note")<=1000);

-- This is a one-time private-history fork, not a dual-write mirror. New main
-- writes stay in the legacy namespace; new library writes stay independent.
-- Shared records are NEVER projected to the workspace-only legacy interface.

INSERT INTO "InspirationState" ("workspaceId","activeRelease","releaseSequence","withdrawalSequence","withdrawalHash","withdrawn","lastSyncAt","lastError","lastSyncAttemptAt","lastSyncFailedAt","syncError","lastWithdrawalAttemptAt","lastWithdrawalAt","lastWithdrawalFailedAt","withdrawalError","updatedAt")
SELECT n."libraryId",n."activeRelease",n."releaseSequence",n."withdrawalSequence",n."withdrawalHash",n."withdrawn",n."lastSyncAt",n."lastError",n."lastSyncAttemptAt",n."lastSyncFailedAt",n."syncError",n."lastWithdrawalAttemptAt",n."lastWithdrawalAt",n."lastWithdrawalFailedAt",n."withdrawalError",n."updatedAt"
FROM "InspirationLibraryState" n JOIN "InspirationLibrary" l ON l."id"=n."libraryId"
WHERE l."kind"='WORKSPACE' AND l."legacyWorkspaceId"=l."id";

INSERT INTO "InspirationRelease" ("id","workspaceId","releaseId","sequence","manifestHash","manifest","snapshot","createdAt")
SELECT n."id",n."libraryId",n."releaseId",n."sequence",n."manifestHash",n."manifest",n."snapshot",n."createdAt"
FROM "InspirationLibraryRelease" n JOIN "InspirationLibrary" l ON l."id"=n."libraryId"
WHERE l."kind"='WORKSPACE' AND l."legacyWorkspaceId"=l."id";

INSERT INTO "InspirationRecord" ("id","workspaceId","caseId","revision","contentHash","imageHash","releaseId","deleted","body","createdAt")
SELECT n."id",n."libraryId",n."caseId",n."revision",n."contentHash",n."imageHash",n."releaseId",n."deleted",n."body",n."createdAt"
FROM "InspirationLibraryRecord" n JOIN "InspirationLibrary" l ON l."id"=n."libraryId"
WHERE l."kind"='WORKSPACE' AND l."legacyWorkspaceId"=l."id";

INSERT INTO "InspirationImage" ("id","workspaceId","releaseId","path","sha256","mimeType","bytes")
SELECT n."id",n."libraryId",n."releaseId",n."path",n."sha256",n."mimeType",n."bytes"
FROM "InspirationLibraryImage" n JOIN "InspirationLibrary" l ON l."id"=n."libraryId"
WHERE l."kind"='WORKSPACE' AND l."legacyWorkspaceId"=l."id";

INSERT INTO "InspirationChat" ("selectedImages","latencyMs","requestId","id","workspaceId","userId","conversationId","question","caseIds","status","answer","citations","error","model","inputTokens","outputTokens","expiresAt","createdAt","updatedAt")
SELECT n."selectedImages",n."latencyMs",n."requestId",n."id",n."workspaceId",n."userId",n."conversationId",n."question",n."caseIds",n."status",n."answer",n."citations",n."error",n."model",n."inputTokens",n."outputTokens",n."expiresAt",n."createdAt",n."updatedAt"
FROM "InspirationLibraryChat" n JOIN "InspirationLibrary" l ON l."id"=n."libraryId"
WHERE l."kind"='WORKSPACE' AND l."legacyWorkspaceId"=l."id" AND n."libraryId"=n."workspaceId";

INSERT INTO "InspirationBookmark" ("id","workspaceId","userId","caseId","revision","projectId","note","createdAt","updatedAt")
SELECT n."id",n."workspaceId",n."userId",n."caseId",n."revision",n."projectId",n."note",n."createdAt",n."updatedAt"
FROM "InspirationLibraryBookmark" n JOIN "InspirationLibrary" l ON l."id"=n."libraryId"
WHERE l."kind"='WORKSPACE' AND l."legacyWorkspaceId"=l."id" AND n."libraryId"=n."workspaceId";

INSERT INTO "InspirationEmbedding" ("id","workspaceId","key","payloadJson","createdAt")
SELECT n."id",n."workspaceId",n."key",n."payloadJson",n."createdAt"
FROM "InspirationLibraryEmbedding" n
WHERE n."key" ~ '^[0-9a-f]{64}$'
   OR (left(n."key",length(n."workspaceId")+1)=n."workspaceId"||':'
       AND substr(n."key",length(n."workspaceId")+2) ~ '^[0-9a-f]{64}$');

INSERT INTO "InspirationFeedback" ("id","workspaceId","userId","caseId","revision","kind","note","status","createdAt","updatedAt")
SELECT n."id",n."workspaceId",n."userId",n."caseId",n."revision",n."kind",n."note",n."status",n."createdAt",n."updatedAt"
FROM "InspirationLibraryFeedback" n JOIN "InspirationLibrary" l ON l."id"=n."libraryId"
WHERE l."kind"='WORKSPACE' AND l."legacyWorkspaceId"=l."id" AND n."libraryId"=n."workspaceId";

-- Preserve legacy task rows exactly. Copy only terminal inspiration receipts;
-- no old worker can see the new queue or change a new library task.
INSERT INTO "InspirationLibraryTask" ("id","workspaceId","inspirationLibraryId","kind","status","progress","jobId","refId","refCount","error","inputJson","resultJson","expiresAt","createdAt","updatedAt")
SELECT "id","workspaceId","inspirationLibraryId","kind","status","progress","jobId","refId","refCount","error","inputJson","resultJson","expiresAt","createdAt","updatedAt" FROM "AsyncTask"
WHERE "kind" IN ('INSPIRATION_SYNC','INSPIRATION_CHAT') AND "status"::text NOT IN ('PENDING','RUNNING');

-- Install the admission guard after copying historical orphan receipts.
CREATE TRIGGER "InspirationLibraryTask_live_workspace"
BEFORE INSERT OR UPDATE OF "workspaceId","status" ON "InspirationLibraryTask"
FOR EACH ROW EXECUTE FUNCTION "require_live_task_workspace"();

-- Older main clients do not know the new queue. Enforce this deletion boundary
-- in PostgreSQL too. Task admission takes KEY SHARE on this same workspace row.
CREATE FUNCTION "protect_live_inspiration_library_workspace"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InspirationLibraryTask" WHERE "workspaceId"=OLD."id" AND "status"::text IN ('PENDING','RUNNING'))
     OR EXISTS (SELECT 1 FROM "InspirationLibraryChat" WHERE "workspaceId"=OLD."id" AND "status"::text IN ('PENDING','RUNNING')) THEN
    RAISE EXCEPTION 'Workspace has active inspiration library work' USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "BrandWorkspace_live_inspiration_library"
BEFORE DELETE ON "BrandWorkspace"
FOR EACH ROW EXECUTE FUNCTION "protect_live_inspiration_library_workspace"();

COMMIT;
